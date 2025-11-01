#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { log, cloudCli, ensureDir, readJsonFile, writeJsonFile, formatCVMWithHealth, checkCVMHealth, extractJsonFromCliOutput } = require('./utils');

const NODES = {
  "prod6": "11",
  "prod7": "12",
  "prod8": "16",
  "prod9": "18",
  "prod10": "17",
}

const NODE_TO_KMS = {
  "prod6": "phala-prod6",
  "prod7": "phala-prod7",
  "prod8": "phala-prod8",
  "prod9": "phala-prod9",
  "prod10": "phala-prod10",
}

class PhalaDeployer {
  constructor() {
    this.scriptDir = __dirname;
    this.configFile = path.join(this.scriptDir, 'deployment-config.json');
    this.deploymentsDir = path.join(this.scriptDir, '.deployments');
    this.vpcServerIdFile = path.join(this.deploymentsDir, '.vpc_server_id');
    this.config = null;

    ensureDir(this.deploymentsDir);
  }

  // Simple state helpers - single source of truth
  getDeploymentState(name) {
    const stateFile = path.join(this.deploymentsDir, name, 'deployment-info.json');
    return readJsonFile(stateFile);
  }

  saveDeploymentState(name, state) {
    ensureDir(path.join(this.deploymentsDir, name));
    const stateFile = path.join(this.deploymentsDir, name, 'deployment-info.json');
    writeJsonFile(stateFile, state);
    log.debug(`Saved state for ${name}`);
  }

  // Load configuration
  loadConfig() {
    this.config = readJsonFile(this.configFile);
    if (!this.config) {
      this.generateDefaultConfig();
    }
    log.info(`Loaded configuration from: ${this.configFile}`);
  }

  // Generate default configuration
  generateDefaultConfig() {
    const defaultConfig = {
      os_image: "dstack-dev-0.5.4",
      vpc_server: {
        name: "mongodb-vpc-server",
        cpu: 1,
        memory: "2G",
        storage: "20G",
        node: "prod9",
        composeFile: "vpc-server.yaml"
      },
      nodes: [
        {
          index: 0,
          name: "mongodb-0",
          cpu: 2,
          memory: "8G",
          storage: "200G",
          node: "prod9",
          composeFile: "mongodb.yaml"
        },
        {
          index: 1,
          name: "mongodb-1",
          cpu: 2,
          memory: "8G",
          storage: "200G",
          node: "prod9",
          composeFile: "mongodb.yaml"
        },
        {
          index: 2,
          name: "mongodb-2",
          cpu: 2,
          memory: "8G",
          storage: "200G",
          node: "prod9",
          composeFile: "mongodb.yaml"
        }
      ],
      "test-app": {
        name: "test-app-0",
        cpu: 1,
        memory: "2G",
        storage: "20G",
        node: "prod9",
        composeFile: "mongo-app.yaml"
      }
    };

    writeJsonFile(this.configFile, defaultConfig);
    log.info(`Generated default configuration at: ${this.configFile}`);
    log.warn('Please review and update the configuration before deploying');
    process.exit(0);
  }

  // Check authentication
  async checkAuth() {
    log.info('Checking authentication status...');
    await cloudCli('auth', 'status');
    log.success('Authentication verified ✓');
  }

  // Execute phala deploy command in specific working directory
  async executeDeploy(args, workingDir = null) {
    const originalCwd = process.cwd();

    try {
      // Change to working directory if specified
      if (workingDir) {
        log.debug(`Working directory: ${workingDir}`);
        process.chdir(workingDir);
      }

      // Execute the deploy command
      const output = await cloudCli('deploy', ...args);
      return output;
    } finally {
      // Always restore original working directory
      if (workingDir) {
        process.chdir(originalCwd);
      }
    }
  }

  async deployWithConfig(config) {
    // Check if already deployed (idempotent)
    const existingState = this.getDeploymentState(config.name);
    if (existingState && existingState.app_id) {
      log.info(`${config.name} already deployed with App ID: ${existingState.app_id}`);
      return existingState.app_id;
    }

    const deploymentDir = path.join(this.deploymentsDir, config.name);
    const nodeId = NODES[config.node];
    const kms = NODE_TO_KMS[config.node];
    if (!nodeId) {
      throw new Error(`Node ID not found for node: ${config.node}`);
    }
    if (!kms) {
      throw new Error(`KMS ID not found for node: ${config.node}`);
    }

    if (!this.config.os_image) {
      throw new Error('OS image is not configured');
    }

    ensureDir(deploymentDir);

    // Copy compose file to deployment directory
    log.debug('Deployment parameters:');
    log.debug(`  Name: ${config.name}, vCPU: ${config.cpu}, Memory: ${config.memory}`);
    log.debug(`  Disk: ${config.storage}, Node: ${config.node} (ID: ${nodeId})`);
    log.debug(`  KMS: ${kms}, Image: ${this.config.os_image}`);

    if (!config.composeFile.startsWith('/')) {
      config.composeFile = path.join(this.scriptDir, config.composeFile);
    }
    const staticEnvs = config.staticEnvs || {};
    const renderedComposeFile = this.renderCompose(config.composeFile, deploymentDir, staticEnvs);

    const args = [
      '--json',  // Add JSON output flag
      '--compose', renderedComposeFile,
      '--name', config.name,
      '--vcpu', config.cpu.toString(),
      '--memory', config.memory,
      '--disk-size', config.storage,
      '--node-id', nodeId,
      '--kms-id', kms,
      '--image', this.config.os_image
    ];

    if (config.envFile) {
      args.push('--env-file', config.envFile);
      log.info(`Using env file: ${config.envFile}`);
    }

    // Save "deploying" state BEFORE calling CLI (protects against CLI failure)
    this.saveDeploymentState(config.name, {
      name: config.name,
      status: 'deploying',
      app_id: null,
      vm_uuid: null,
      started_at: new Date().toISOString()
    });

    try {
      const output = await this.executeDeploy(args, deploymentDir);

      // Extract JSON from mixed CLI output
      const jsonResult = extractJsonFromCliOutput(output);
      log.debug('JSON Response:');
      log.debug(JSON.stringify(jsonResult, null, 2));

      // Check if deployment was successful
      if (!jsonResult.success) {
        throw new Error(`Deployment failed: ${jsonResult.error || 'Unknown error'}`);
      }

      // Extract App ID from JSON response
      const appId = jsonResult.app_id;
      if (!appId) {
        throw new Error('Failed to extract App ID from deployment output');
      }

      log.success(`Deployed ${jsonResult.name} with App ID: ${appId}`);

      // Log additional info if available
      if (jsonResult.vm_uuid) {
        log.info(`VM UUID: ${jsonResult.vm_uuid}`);
      }
      if (jsonResult.dashboard_url) {
        log.info(`Dashboard: ${jsonResult.dashboard_url}`);
      }

      // Update deployment state with success
      this.saveDeploymentState(config.name, {
        name: config.name,
        status: 'deployed',
        app_id: appId,
        vm_uuid: jsonResult.vm_uuid || null,
        dashboard_url: jsonResult.dashboard_url || null,
        deployed_at: new Date().toISOString()
      });

      return appId;
    } catch (error) {
      // Save failed state so we can recover
      this.saveDeploymentState(config.name, {
        name: config.name,
        status: 'failed',
        app_id: null,
        vm_uuid: null,
        error: error.message,
        failed_at: new Date().toISOString()
      });
      log.error(`Deployment failed: ${error.message}`);
      throw error;
    }
  }

  // Deploy node
  async deployNode(index, vpcServerId) {
    const nodeConfig = this.config.nodes[index];
    log.info(`Deploying node: ${nodeConfig.name}...`);

    const deploymentDir = path.join(this.deploymentsDir, nodeConfig.name);
    ensureDir(deploymentDir);

    const nodeInd = nodeConfig.index;
    if (nodeInd === undefined) {
      throw new Error(`Node index is not defined for node: ${nodeConfig.name}`);
    }
    // Write env file directly to deployment directory
    const envFile = path.join(deploymentDir, `.envfile`);
    const envContent = `NODE_IND=${nodeInd}\nVPC_SERVER_APP_ID=${vpcServerId}`;
    fs.writeFileSync(envFile, envContent);

    return await this.deployWithConfig({
      ...nodeConfig,
      envFile: envFile,
      staticEnvs: {
        VPC_SERVER_APP_ID: vpcServerId,
      }
    });
  }

  // Render template file with variable substitution
  renderFile(srcFile, dstFile, variables = {}) {
    let content = fs.readFileSync(srcFile, 'utf8');

    // Replace all variables in the format ${VARIABLE_NAME}
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
      content = content.replace(pattern, value);
    }

    fs.writeFileSync(dstFile, content);
  }

  // Convenient method to render compose files to deployment directory
  renderCompose(srcFile, deploymentDir, variables = {}) {
    const dstFile = path.join(deploymentDir, "docker-compose.yml");
    this.renderFile(srcFile, dstFile, variables);
    return dstFile;
  }

  // Wait for health check
  async waitForHealth(appId, name) {
  }

  // Step 1: Deploy VPC server with dummy container
  async deployStep1() {
    await this.checkAuth();
    this.loadConfig();

    log.info('Step 1: Deploying VPC server with dummy container...');

    try {
      const appId = await this.deployWithConfig({
        ...this.config.vpc_server,
        staticEnvs: {
          VPC_ALLOWED_APPS: 'any',
        }
      });

      // Save VPC server ID for later steps
      fs.writeFileSync(this.vpcServerIdFile, appId);

      log.success('Step 1 completed: VPC server deployed with dummy container');
      log.info(`VPC Server App ID: ${appId}`);

      return appId;
    } catch (error) {
      log.error(`Step 1 failed: ${error.message}`);
      throw error;
    }
  }

  // Step 2: Deploy MongoDB nodes
  async deployStep2() {
    await this.checkAuth();
    this.loadConfig();

    log.info('Step 2: Deploying MongoDB nodes...');

    // Check if VPC server exists
    if (!fs.existsSync(this.vpcServerIdFile)) {
      log.error('VPC server not found. Please run step 1 first: node deploy.js step1');
      process.exit(1);
    }

    const vpcServerId = fs.readFileSync(this.vpcServerIdFile, 'utf8').trim();
    log.info(`Using VPC Server App ID: ${vpcServerId}`);

    const nodeAppIds = [];

    for (const [index, nodeConfig] of this.config.nodes.entries()) {
      log.info(`Deploying node ${index}: ${nodeConfig.name}`);
      const appId = await this.deployNode(index, vpcServerId);
      nodeAppIds.push(appId);
    }

    // Save node app IDs for step 3
    const nodeIdsFile = path.join(this.deploymentsDir, '.mongo_node_ids');
    fs.writeFileSync(nodeIdsFile, nodeAppIds.join(','));

    log.success('Step 2 completed: All MongoDB nodes deployed');
    log.info(`MongoDB Node App IDs: ${nodeAppIds.join(', ')}`);

    return nodeAppIds;
  }

  // Step 3: Redeploy VPC server with correct configuration
  async deployStep3() {
    this.loadConfig();

    log.info('Step 3: Redeploying VPC server with correct configuration...');

    // Check if node IDs exist
    const nodeIdsFile = path.join(this.deploymentsDir, '.mongo_node_ids');
    if (!fs.existsSync(nodeIdsFile)) {
      log.error('MongoDB node IDs not found. Please run step 2 first: node deploy.js step2');
      process.exit(1);
    }

    const mongoNodeIds = fs.readFileSync(nodeIdsFile, 'utf8').trim().split(',');
    log.info(`MongoDB Node App IDs: ${mongoNodeIds.join(', ')}`);

    // Get current VPC server app ID
    if (!fs.existsSync(this.vpcServerIdFile)) {
      log.error('VPC server not found. Cannot redeploy without existing VPC server.');
      process.exit(1);
    }

    const currentVpcAppId = fs.readFileSync(this.vpcServerIdFile, 'utf8').trim();
    log.info(`Current VPC Server App ID: ${currentVpcAppId}`);

    // Step 3a: Create VPC_ALLOWED_APPS value and upgrade VPC server
    const allowedApps = mongoNodeIds.join(',');

    // Prepare VPC server deployment directory
    const vpcDeploymentDir = path.join(this.deploymentsDir, this.config.vpc_server.name);

    // Render vpc-server.yaml template with VPC_ALLOWED_APPS
    const sourceCompose = path.join(this.scriptDir, this.config.vpc_server.composeFile);
    const targetCompose = this.renderCompose(sourceCompose, vpcDeploymentDir, {
      VPC_ALLOWED_APPS: allowedApps
    });

    log.info('Upgrading VPC server with updated configuration...');
    log.info(`Setting VPC_ALLOWED_APPS to: ${allowedApps}`);

    // Use cvms upgrade command (no need to stop first)
    const originalDir = process.cwd();
    process.chdir(vpcDeploymentDir);

    try {
      const upgradeOutput = await cloudCli('cvms', 'upgrade', currentVpcAppId,
        '--compose', targetCompose
      );
      log.info('VPC server upgrade command completed');
      log.debug(`Upgrade output: ${upgradeOutput}`);
    } finally {
      process.chdir(originalDir);
    }

    const appId = currentVpcAppId; // App ID doesn't change during upgrade

    log.success('Step 3 completed: VPC server redeployed with correct configuration');
    log.info(`VPC Server App ID: ${appId}`);
    log.info(`VPC_ALLOWED_APPS: ${allowedApps}`);

    return appId;
  }

  // Deploy entire cluster (all three steps)
  async deployCluster() {
    log.info('Starting complete MongoDB cluster deployment...');
    log.info('This will execute all three steps automatically\n');

    try {
      // Step 1
      await this.deployStep1();
      log.info('');

      // Step 2 
      await this.deployStep2();
      log.info('');

      // Step 3
      // await this.deployStep3();

      console.log('\n' + '═'.repeat(80));
      log.success('🎉 Complete MongoDB cluster deployment finished!');
      console.log('═'.repeat(80));

    } catch (error) {
      log.error(`Cluster deployment failed: ${error.message}`);
      process.exit(1);
    }
  }

  // Fetch CVM data for all deployments
  async fetchCVMs(deploymentConfigs, silentErrors = false) {
    const cvms = [];

    for (const config of deploymentConfigs) {
      try {
        const cliOutput = await cloudCli('cvms', 'get', config.app_id, '--json');
        log.debug(`Got output for ${config.name}: ${cliOutput ? cliOutput.substring(0, 100) : 'empty'}`);

        if (!cliOutput) {
          if (!silentErrors) log.warn(`Empty output for ${config.name}`);
          continue;
        }

        const parsed = extractJsonFromCliOutput(cliOutput);
        cvms.push({
          ...parsed,
          deploymentName: config.name
        });
      } catch (error) {
        if (!silentErrors) {
          log.warn(`Failed to fetch CVM for ${config.name}: ${error.message}`);
        }
      }
    }

    return cvms;
  }

  // Show status of deployed cluster
  async showStatus(watch = false, interval = 5000) {
    await this.checkAuth();

    const showStatusOnce = async () => {
      // Buffer output to prevent flickering in watch mode
      const output = [];

      try {
        if (!watch) {
          log.info('Scanning deployment configurations...');
        }

        // Read all deployment states from deployment-info.json
        const deploymentConfigs = [];
        if (fs.existsSync(this.deploymentsDir)) {
          const deployments = fs.readdirSync(this.deploymentsDir).filter(name =>
            !name.startsWith('.') // Skip hidden files like .vpc_server_id
          );

          for (const deploymentName of deployments) {
            const state = this.getDeploymentState(deploymentName);
            if (state && state.app_id) {
              deploymentConfigs.push({
                name: deploymentName,
                app_id: state.app_id,
                vm_uuid: state.vm_uuid
              });
            } else if (state && state.status === 'deploying') {
              if (!watch) {
                log.warn(`${deploymentName} is still deploying or deployment failed`);
              }
            }
          }
        }

        if (deploymentConfigs.length === 0) {
          if (watch) {
            output.push('No deployment configurations found');
          } else {
            log.info('No deployment configurations found');
          }
          // Print buffered output in watch mode
          if (watch) {
            console.clear();
            const now = new Date().toLocaleTimeString();
            console.log(`🔄 Auto-refreshing every ${interval / 1000}s | Last update: ${now}`);
            console.log('   Press Ctrl+C to stop\n');
            console.log(output.join('\n'));
          }
          return;
        }

        if (!watch) {
          log.info('Fetching CVM status from Phala Cloud...');
        }

        // Fetch all CVM data
        const matchedCvms = await this.fetchCVMs(deploymentConfigs, watch);

        if (matchedCvms.length === 0) {
          if (watch) {
            output.push('No matching CVMs found');
          } else {
            log.info('No matching CVMs found');
          }
          // Print buffered output in watch mode
          if (watch) {
            console.clear();
            const now = new Date().toLocaleTimeString();
            console.log(`🔄 Auto-refreshing every ${interval / 1000}s | Last update: ${now}`);
            console.log('   Press Ctrl+C to stop\n');
            console.log(output.join('\n'));
          }
          return;
        }

        // Categorize by deployment name patterns
        const vpcServer = matchedCvms.find(cvm => cvm.deploymentName.includes('vpc-server'));
        const mongoNodes = matchedCvms.filter(cvm =>
          cvm.deploymentName.match(/^mongodb-[0-9]+$/)
        ).sort((a, b) => a.deploymentName.localeCompare(b.deploymentName));
        const demoApps = matchedCvms.filter(cvm =>
          cvm.deploymentName.includes('app') ||
          (cvm.deploymentName.includes('mongodb') && !cvm.deploymentName.match(/^mongodb-[0-9]+$/) && !cvm.deploymentName.includes('vpc-server'))
        );

        // Fetch all health data BEFORE displaying anything
        const healthData = new Map();
        for (const cvm of matchedCvms) {
          if (cvm.status === 'running' && cvm.dapp_dashboard_url) {
            healthData.set(cvm.deploymentName, await checkCVMHealth(cvm.dapp_dashboard_url));
          }
        }

        // Now build the output (all data is ready)
        output.push('\n📊 MongoDB Cluster Status\n');
        output.push('═'.repeat(80));

        // Display VPC Server
        if (vpcServer) {
          output.push('🌐 VPC Server:');
          output.push(...formatCVMWithHealth(vpcServer, healthData.get(vpcServer.deploymentName)));
          output.push('');
        }

        // Display MongoDB Nodes
        if (mongoNodes.length > 0) {
          output.push('🗄️  MongoDB Cluster Nodes:');
          for (const cvm of mongoNodes) {
            output.push(...formatCVMWithHealth(cvm, healthData.get(cvm.deploymentName)));
          }
          output.push('');
        }

        // Display Demo Apps
        if (demoApps.length > 0) {
          output.push('🚀 Demo Applications:');
          for (const cvm of demoApps) {
            output.push(...formatCVMWithHealth(cvm, healthData.get(cvm.deploymentName)));
          }
          output.push('');
        }

        // Summary
        output.push('═'.repeat(80));
        const totalNodes = matchedCvms.length;
        const runningNodes = matchedCvms.filter(cvm => cvm.status === 'running').length;
        output.push(`📈 Summary: ${runningNodes}/${totalNodes} nodes running`);

        if (runningNodes === totalNodes) {
          output.push('✅ All cluster nodes are healthy!');
        } else {
          output.push('⚠️  Some nodes need attention');
        }

        // Clear screen and print everything atomically in watch mode
        if (watch) {
          console.clear();
          const now = new Date().toLocaleTimeString();
          console.log(`🔄 Auto-refreshing every ${interval / 1000}s | Last update: ${now}`);
          console.log('   Press Ctrl+C to stop\n');
          console.log(output.join('\n'));
        } else {
          console.log(output.join('\n'));
        }

      } catch (error) {
        console.error(error)
        log.error(`Failed to fetch cluster status: ${error.message}`);
      }
    };

    // Run once or in watch mode
    if (!watch) {
      await showStatusOnce();
    } else {
      // Set up graceful exit handler
      process.on('SIGINT', () => {
        console.log('\n\n👋 Stopping status monitor...');
        process.exit(0);
      });

      // Run in loop
      while (true) {
        await showStatusOnce();
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
  }

  // Deploy test app
  async deployApp() {
    await this.checkAuth();
    this.loadConfig();

    // Check if VPC server exists
    if (!fs.existsSync(this.vpcServerIdFile)) {
      log.error('VPC server ID not found. Please deploy the cluster first using: `node deploy cluster`');
      process.exit(1);
    }

    const vpcServerId = fs.readFileSync(this.vpcServerIdFile, 'utf8').trim();
    log.info(`Using VPC Server App ID: ${vpcServerId}`);

    const appConfig = this.config['test-app'];
    const appIndex = 0;
    const appName = appConfig.name;

    log.info('Deploying demo application...');

    const deploymentDir = path.join(this.deploymentsDir, appName);
    ensureDir(deploymentDir);

    // Write env file directly to deployment directory
    const envFile = path.join(deploymentDir, `.envfile`);
    const envContent = `NODE_IND=${appIndex}\nVPC_SERVER_APP_ID=${vpcServerId}`;
    fs.writeFileSync(envFile, envContent);

    log.info(`Deploying ${appName}...`);
    try {
      const appId = await this.deployWithConfig({
        ...appConfig,
        name: appName,
        envFile: envFile,
        staticEnvs: {
          VPC_SERVER_APP_ID: vpcServerId,
        }
      });

      log.success(`Demo app deployed with App ID: ${appId}`);

      // Get app info
      try {
        const appInfo = await cloudCli('cvms', 'get', `app_${appId}`);
        console.log('\nApp details:');
        console.log(appInfo);
      } catch (error) {
        log.warn(`Failed to get app details: ${error.message}`);
      }

    } catch (error) {
      log.error(`Demo app deployment failed: ${error.message}`);
      process.exit(1);
    }
  }


  // Destroy all deployed CVMs
  async teardown(removeDeploymentDir = false) {
    await this.checkAuth();

    console.log('\n⚠️  WARNING: This will delete all deployed CVMs for this cluster');
    console.log('═'.repeat(80));

    log.info('Scanning deployment configurations...');

    // Read all deployment states
    const deploymentConfigs = [];
    if (fs.existsSync(this.deploymentsDir)) {
      const deployments = fs.readdirSync(this.deploymentsDir).filter(name =>
        !name.startsWith('.') // Skip hidden files
      );

      for (const deploymentName of deployments) {
        const deploymentDir = path.join(this.deploymentsDir, deploymentName);
        const state = this.getDeploymentState(deploymentName);

        if (state && (state.app_id || state.vm_uuid)) {
          deploymentConfigs.push({
            name: deploymentName,
            app_id: state.app_id,
            vm_uuid: state.vm_uuid,
            deploymentDir
          });
        }
        // Silently skip directories without state (already cleaned up)
      }
    }

    if (deploymentConfigs.length === 0) {
      log.info('No deployed CVMs found. Everything is already clean!');
      return;
    }

    console.log(`\nFound ${deploymentConfigs.length} deployments to remove:`);
    deploymentConfigs.forEach(config => {
      const id = config.app_id || config.vm_uuid || 'unknown';
      const idDisplay = id !== 'unknown' ? `${id.substring(0, 8)}...` : id;
      console.log(`  • ${config.name} (ID: ${idDisplay})`);
    });

    console.log('\n🗑️  Starting teardown...\n');

    let successCount = 0;
    let failCount = 0;

    // Check if we need to fetch CVM list for missing app_ids
    const needsFetch = deploymentConfigs.some(config => !config.app_id);
    let allCvms = null;

    if (needsFetch) {
      log.info('Fetching CVM list to get missing app IDs...');
      const listOutput = await cloudCli('cvms', 'list', '--json');

      // Parse CVM list
      try {
        allCvms = JSON.parse(listOutput);
      } catch (parseError) {
        const startIndex = listOutput.indexOf('[');
        if (startIndex !== -1) {
          const jsonPart = listOutput.substring(startIndex);
          try {
            allCvms = JSON.parse(jsonPart);
          } catch (e) {
            log.error('Failed to parse CVM list');
            // Continue anyway with what we have
          }
        }
      }
    }

    // Delete each CVM
    for (const config of deploymentConfigs) {
      try {
        log.info(`Deleting ${config.name}...`);

        let appId = config.app_id;

        // If we don't have app_id, try to find it from the CVM list
        if (!appId && allCvms && config.vm_uuid) {
          const cvm = allCvms.find(c => c.hosted.id === config.vm_uuid);
          if (cvm) {
            appId = cvm.hosted.app_id;
            log.debug(`Found app_id from CVM list: ${appId} for ${config.name}`);
          }
        }

        if (!appId) {
          log.warn(`No app_id found for ${config.name}`);
          failCount++;
          continue;
        }

        // Change to deployment directory for phala CLI context
        const originalDir = process.cwd();
        process.chdir(config.deploymentDir);

        let deleted = false;
        try {
          // Delete the CVM using phala CLI with the correct app_id
          await cloudCli('cvms', 'delete', appId, '--force');
          log.success(`✓ Deleted ${config.name}`);
          deleted = true;
        } catch (error) {
          // Check if CVM is already deleted (not detected)
          if (error.message.includes('not detected')) {
            log.success(`✓ ${config.name} (already deleted)`);
            deleted = true;
          } else {
            throw error; // Re-throw other errors
          }
        } finally {
          process.chdir(originalDir);
        }

        if (deleted) {
          successCount++;

          // Always clean up state files for deleted CVMs
          const stateFile = path.join(config.deploymentDir, 'deployment-info.json');
          if (fs.existsSync(stateFile)) {
            fs.unlinkSync(stateFile);
            log.debug(`Removed state file for ${config.name}`);
          }

          // Clean up .phala directory to prevent CLI from reusing old CVM references
          const phalaDir = path.join(config.deploymentDir, '.phala');
          if (fs.existsSync(phalaDir)) {
            fs.rmSync(phalaDir, { recursive: true, force: true });
            log.debug(`Removed stale .phala directory for ${config.name}`);
          }

          // Remove entire deployment directory if --rm flag is set
          if (removeDeploymentDir) {
            try {
              fs.rmSync(config.deploymentDir, { recursive: true, force: true });
              log.debug(`Removed deployment directory: ${config.deploymentDir}`);
            } catch (error) {
              log.warn(`Failed to remove deployment directory: ${error.message}`);
            }
          }
        }

      } catch (error) {
        log.error(`✗ Failed to delete ${config.name}: ${error.message}`);
        failCount++;
      }
    }

    // Handle VPC server ID file and deployments directory
    if (removeDeploymentDir) {
      // Remove VPC server ID file
      if (fs.existsSync(this.vpcServerIdFile)) {
        fs.unlinkSync(this.vpcServerIdFile);
        log.debug('Removed VPC server ID file');
      }

      // Remove entire deployments directory if empty or if --rm flag is set
      if (fs.existsSync(this.deploymentsDir)) {
        try {
          const remainingDirs = fs.readdirSync(this.deploymentsDir);
          if (remainingDirs.length === 0 || removeDeploymentDir) {
            fs.rmSync(this.deploymentsDir, { recursive: true, force: true });
            log.debug('Removed deployments directory');
          }
        } catch (error) {
          log.warn(`Failed to remove deployments directory: ${error.message}`);
        }
      }
    } else {
      // Keep VPC server ID file for reference
      if (fs.existsSync(this.vpcServerIdFile)) {
        log.debug('Keeping VPC server ID file for reference');
      }
    }

    console.log('\n' + '═'.repeat(80));
    console.log(`📊 Teardown Summary:`);
    console.log(`   ✅ Successfully deleted: ${successCount}`);
    if (failCount > 0) {
      console.log(`   ❌ Failed to delete: ${failCount}`);
    }
    if (removeDeploymentDir) {
      console.log(`   🗑️  Removed deployment directories`);
    }

    if (successCount === deploymentConfigs.length) {
      console.log('\n✨ All CVMs successfully removed!');
    } else if (failCount > 0) {
      console.log('\n⚠️  Some CVMs could not be removed. Check logs for details.');
    }
  }
}

// Main execution
async function main() {
  const deployer = new PhalaDeployer();
  const command = process.argv[2];
  const args = process.argv.slice(3);

  switch (command) {
    case 'step1':
      await deployer.deployStep1();
      break;
    case 'step2':
      await deployer.deployStep2();
      break;
    case 'step3':
      await deployer.deployStep3();
      break;
    case 'cluster':
      await deployer.deployCluster();
      break;
    case 'app':
      await deployer.deployApp();
      break;
    case 'status':
      // Check for --watch flag
      const watchMode = args.includes('--watch') || args.includes('-w');
      let interval = 5000; // Default 5 seconds

      // Check for custom interval
      const intervalIndex = args.findIndex(arg => arg === '--interval' || arg === '-i');
      if (intervalIndex !== -1 && args[intervalIndex + 1]) {
        const customInterval = parseInt(args[intervalIndex + 1]) * 1000;
        if (!isNaN(customInterval) && customInterval >= 1000) {
          interval = customInterval;
        }
      }

      await deployer.showStatus(watchMode, interval);
      break;
    case 'down':
      // Check for --rm flag to remove deployment directories
      const removeDeployments = args.includes('--rm');
      await deployer.teardown(removeDeployments);
      break;
    default:
      console.log('Usage: node deploy.js {step1|step2|step3|cluster|app|status|down} [options]');
      console.log('\nThree-step workflow:');
      console.log('  step1                Deploy VPC server with dummy container');
      console.log('  step2                Deploy MongoDB nodes with VPC server app ID');
      console.log('  step3                Upgrade VPC server with VPC_ALLOWED_APPS');
      console.log('\nCommands:');
      console.log('  cluster       Execute all three steps automatically');
      console.log('  app           Deploy demo application (requires cluster to be deployed first)');
      console.log('  status [options]     Show status of deployed cluster nodes');
      console.log('    --watch, -w        Auto-refresh status in a loop');
      console.log('    --interval, -i <s> Set refresh interval in seconds (default: 5)');
      console.log('  down [options]       Remove all deployed CVMs');
      console.log('    --rm               Also remove .deployments directory');
      console.log('\nExamples:');
      console.log('  node deploy.js cluster    # Deploy the mongodb cluster');
      console.log('  node deploy.js app        # Deploy demo application');
      console.log('');
      console.log('  # Monitor deployments:');
      console.log('  node deploy.js status --watch        # Monitor cluster status');
      console.log('\nEnvironment variables:');
      console.log('  DEBUG=1              Enable debug output');
      process.exit(1);
  }
}

// Run main function
main().catch(error => {
  log.error(`Unexpected error: ${error.message}`);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});