#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

// Logging functions
const log = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}[ERROR]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  debug: (msg) => {
    if (process.env.DEBUG) {
      console.log(`${colors.cyan}[DEBUG]${colors.reset} ${msg}`);
    }
  }
};

const NODES = {
  "prod6-eth": "11",
}

// Helper function to execute phala CLI commands
async function cloudCli(...args) {
  const { spawn } = require('child_process');
  const command = 'npx';
  const fullArgs = ['phala', ...args];

  log.debug(`Executing: ${command} ${fullArgs.join(' ')}`);

  return new Promise((resolve, reject) => {
    let output = '';
    let errorOutput = '';

    const proc = spawn(command, fullArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}\n${errorOutput}`));
      } else {
        resolve(output.trim());
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}

class PhalaDeployer {
  constructor() {
    this.scriptDir = __dirname;
    this.configFile = path.join(this.scriptDir, 'deployment-config.json');
    this.deploymentsDir = path.join(this.scriptDir, '.deployments');
    this.vpcServerIdFile = path.join(this.deploymentsDir, '.vpc_server_id');
    this.config = null;

    // Ensure deployments directory exists
    if (!fs.existsSync(this.deploymentsDir)) {
      fs.mkdirSync(this.deploymentsDir, { recursive: true });
    }
  }


  // Load configuration
  loadConfig() {
    if (!fs.existsSync(this.configFile)) {
      this.generateDefaultConfig();
    }

    try {
      const configData = fs.readFileSync(this.configFile, 'utf8');
      this.config = JSON.parse(configData);
      log.info(`Loaded configuration from: ${this.configFile}`);
    } catch (error) {
      log.error(`Failed to load config: ${error.message}`);
      process.exit(1);
    }
  }

  // Generate default configuration
  generateDefaultConfig() {
    const defaultConfig = {
      kms: "kms_dA2M76mq",
      os_image: "dstack-dev-0.5.4",
      vpc_server: {
        name: "mongodb-vpc-server",
        cpu: 1,
        memory: "2G",
        storage: "20G",
        node: "prod6-eth",
        composeFile: "vpc-server.yaml"
      },
      nodes: [
        {
          index: 0,
          name: "mongodb-0",
          cpu: 2,
          memory: "8G",
          storage: "200G",
          node: "prod6-eth",
          composeFile: "mongodb.yaml"
        },
        {
          index: 1,
          name: "mongodb-1",
          cpu: 2,
          memory: "8G",
          storage: "200G",
          node: "prod6-eth",
          composeFile: "mongodb.yaml"
        },
        {
          index: 2,
          name: "mongodb-2",
          cpu: 2,
          memory: "8G",
          storage: "200G",
          node: "prod6-eth",
          composeFile: "mongodb.yaml"
        }
      ],
      "test-app": {
        name: "test-app-0",
        cpu: 1,
        memory: "2G",
        storage: "20G",
        node: "prod6-eth",
        composeFile: "mongo-app.yaml"
      }
    };

    fs.writeFileSync(this.configFile, JSON.stringify(defaultConfig, null, 2));
    log.info(`Generated default configuration at: ${this.configFile}`);
    log.warn('Please review and update the configuration before deploying');
    process.exit(0);
  }

  // Check authentication
  async checkAuth() {
    try {
      log.info('Checking authentication status...');
      execSync('npx phala auth status', { stdio: 'pipe' });
      log.success('Authentication verified ✓');
    } catch (error) {
      log.error('Not authenticated with Phala Network');
      log.info('Please run: npx phala auth login');
      process.exit(1);
    }
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
    const deploymentDir = path.join(this.deploymentsDir, config.name);
    // if the dir is already exists, skip the deploy
    if (fs.existsSync(deploymentDir)) {
      const infoFile = path.join(deploymentDir, 'deployment-info.json');
      if (fs.existsSync(infoFile)) {
        const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
        log.info(`Deployment directory already exists for ${config.name}`);
        return info.app_id;
      }
    }
    const nodeId = NODES[config.node];
    if (!nodeId) {
      throw new Error(`Node ID not found for node: ${config.node}`);
    }
    // Validate configuration
    if (!this.config.kms) {
      throw new Error('KMS ID is not configured');
    }
    if (!this.config.os_image) {
      throw new Error('OS image is not configured');
    }

    // Create isolated deployment directory
    if (!fs.existsSync(deploymentDir)) {
      fs.mkdirSync(deploymentDir, { recursive: true });
    }

    // Copy compose file to deployment directory
    log.debug('Deployment parameters:');
    log.debug(`  Name: ${config.name}, vCPU: ${config.cpu}, Memory: ${config.memory}`);
    log.debug(`  Disk: ${config.storage}, Node: ${config.node} (ID: ${nodeId})`);
    log.debug(`  KMS: ${this.config.kms}, Image: ${this.config.os_image}`);

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
      '--kms-id', this.config.kms,
      '--image', this.config.os_image
    ];

    if (config.envFile) {
      args.push('--env-file', config.envFile);
      log.debug(`Using env file: ${config.envFile}`);
    }

    try {
      const output = await this.executeDeploy(args, deploymentDir);

      // Extract JSON from mixed output
      let jsonResult;
      try {
        // Try to parse the entire output as JSON first
        jsonResult = JSON.parse(output);
      } catch (parseError) {
        // If that fails, look for JSON in the output
        const lines = output.split('\n');

        // Look for a line that starts with { and ends with }
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
              jsonResult = JSON.parse(trimmed);
              break;
            } catch (e) {
              continue;
            }
          }
        }

        // If still no JSON found, try to find JSON block
        if (!jsonResult) {
          const jsonMatch = output.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              jsonResult = JSON.parse(jsonMatch[0]);
            } catch (e) {
              throw new Error(`Failed to parse JSON from output: ${output}`);
            }
          } else {
            throw new Error(`No JSON found in output: ${output}`);
          }
        }
      }

      log.debug('JSON Response:');
      log.debug(JSON.stringify(jsonResult, null, 2));

      // Check if deployment was successful
      if (!jsonResult.success) {
        throw new Error(`Deployment failed: ${jsonResult.error || 'Unknown error'}`);
      }

      // Extract App ID from JSON response
      const appId = jsonResult.app_id;
      if (!appId) {
        log.error('Could not find App ID in JSON response:');
        console.log(JSON.stringify(jsonResult, null, 2));
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

      // Store deployment info in our own config file
      const deploymentInfoFile = path.join(deploymentDir, 'deployment-info.json');
      const deploymentInfo = {
        name: config.name,
        app_id: appId,
        vm_uuid: jsonResult.vm_uuid || null,
        dashboard_url: jsonResult.dashboard_url || null,
        deployed_at: new Date().toISOString()
      };
      fs.writeFileSync(deploymentInfoFile, JSON.stringify(deploymentInfo, null, 2));
      log.debug(`Saved deployment info to ${deploymentInfoFile}`);

      return appId;
    } catch (error) {
      log.error(`Deployment failed: ${error.message}`);
      throw error;
    }
  }

  // Deploy node
  async deployNode(index, vpcServerId) {
    const nodeConfig = this.config.nodes[index];

    log.info(`Deploying node: ${nodeConfig.name}...`);

    // Create deployment directory first
    const deploymentDir = path.join(this.deploymentsDir, nodeConfig.name);
    if (!fs.existsSync(deploymentDir)) {
      fs.mkdirSync(deploymentDir, { recursive: true });
    }

    const nodeInd = nodeConfig.index;
    if (nodeInd === undefined) {
      throw new Error(`Node index is not defined for node: ${nodeConfig.name}`);
    }
    // Write env file directly to deployment directory
    const envFile = path.join(deploymentDir, `.envfile`);
    const envContent = `NODE_IND=${nodeInd}\nVPC_SERVER_APP_ID=${vpcServerId}`;
    fs.writeFileSync(envFile, envContent);

    try {
      const appId = await this.deployWithConfig({
        ...nodeConfig,
        envFile: envFile,
        staticEnvs: {
          VPC_SERVER_APP_ID: vpcServerId,
        }
      });

      return appId;
    } catch (error) {
      throw error;
    }
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

  // Show status of deployed cluster
  async showStatus(watch = false, interval = 5000) {
    await this.checkAuth();

    const showStatusOnce = async () => {
      // Clear screen if in watch mode
      if (watch) {
        console.clear();
        const now = new Date().toLocaleTimeString();
        console.log(`🔄 Auto-refreshing every ${interval / 1000}s | Last update: ${now}`);
        console.log('   Press Ctrl+C to stop\n');
      }

      try {
        if (!watch) {
          log.info('Scanning deployment configurations...');
        }

        // Read all deployment configs to get CVM UUIDs
        const deploymentConfigs = [];
        if (fs.existsSync(this.deploymentsDir)) {
          const deployments = fs.readdirSync(this.deploymentsDir);

          for (const deploymentName of deployments) {
            const configPath = path.join(this.deploymentsDir, deploymentName, '.phala', 'config');
            if (fs.existsSync(configPath)) {
              try {
                const configContent = fs.readFileSync(configPath, 'utf8');
                const config = JSON.parse(configContent);
                deploymentConfigs.push({
                  name: deploymentName,
                  uuid: config.cvmUuid,
                  configPath
                });
              } catch (error) {
                log.warn(`Failed to read config for ${deploymentName}: ${error.message}`);
              }
            }
          }
        }

        if (deploymentConfigs.length === 0) {
          if (!watch) {
            log.info('No deployment configurations found');
          } else {
            console.log('No deployment configurations found');
          }
          return;
        }

        if (!watch) {
          log.info('Fetching CVM status from Phala Cloud...');
        }

        // Get all CVMs from Phala Cloud
        const output = await cloudCli('cvms', 'list', '--json');

        // Extract JSON from mixed output
        let allCvms;
        try {
          allCvms = JSON.parse(output);
        } catch (parseError) {
          const startIndex = output.indexOf('[');
          if (startIndex !== -1) {
            const jsonPart = output.substring(startIndex);
            try {
              allCvms = JSON.parse(jsonPart);
            } catch (e) {
              throw new Error(`Failed to parse JSON from CLI output: ${output.slice(0, 200)}...`);
            }
          } else {
            throw new Error(`No JSON array found in CLI output: ${output.slice(0, 200)}...`);
          }
        }

        // Match deployment configs with CVMs
        const matchedCvms = [];
        for (const config of deploymentConfigs) {
          const cvm = allCvms.find(c => c.hosted.id === config.uuid);
          if (cvm) {
            matchedCvms.push({
              ...cvm,
              deploymentName: config.name,
              configPath: config.configPath
            });
          } else {
            log.warn(`CVM not found for deployment ${config.name} (UUID: ${config.uuid})`);
          }
        }

        if (matchedCvms.length === 0) {
          log.info('No matching CVMs found');
          return;
        }

        console.log('\n📊 MongoDB Cluster Status\n');
        console.log('═'.repeat(80));

        // Categorize by deployment name patterns
        const vpcServer = matchedCvms.find(cvm => cvm.deploymentName.includes('vpc-server'));
        const mongoNodes = matchedCvms.filter(cvm =>
          cvm.deploymentName.match(/^mongodb-[0-9]+$/)
        ).sort((a, b) => a.deploymentName.localeCompare(b.deploymentName));
        const demoApps = matchedCvms.filter(cvm =>
          cvm.deploymentName.includes('app') ||
          (cvm.deploymentName.includes('mongodb') && !cvm.deploymentName.match(/^mongodb-[0-9]+$/) && !cvm.deploymentName.includes('vpc-server'))
        );

        // Display VPC Server
        if (vpcServer) {
          console.log('🌐 VPC Server:');
          await this.displayCVMWithHealth(vpcServer);
          console.log('');
        }

        // Display MongoDB Nodes
        if (mongoNodes.length > 0) {
          console.log('🗄️  MongoDB Cluster Nodes:');
          for (const cvm of mongoNodes) {
            await this.displayCVMWithHealth(cvm);
          }
          console.log('');
        }

        // Display Demo Apps
        if (demoApps.length > 0) {
          console.log('🚀 Demo Applications:');
          for (const cvm of demoApps) {
            await this.displayCVMWithHealth(cvm);
          }
          console.log('');
        }

        // Summary
        console.log('═'.repeat(80));
        const totalNodes = matchedCvms.length;
        const runningNodes = matchedCvms.filter(cvm => cvm.hosted.status === 'running').length;
        console.log(`📈 Summary: ${runningNodes}/${totalNodes} nodes running`);

        if (runningNodes === totalNodes) {
          console.log('✅ All cluster nodes are healthy!');
        } else {
          console.log('⚠️  Some nodes need attention');
        }

      } catch (error) {
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

  // Helper function to display CVM with health check
  async displayCVMWithHealth(cvm) {
    const statusIcon = cvm.hosted.status === 'running' ? '✅' :
      cvm.hosted.status === 'stopped' ? '🔴' : '⚠️';

    const name = cvm.deploymentName.padEnd(25);
    const status = cvm.hosted.status.padEnd(10);
    const uptime = cvm.hosted.uptime || 'N/A';
    const appId = cvm.hosted.id.substring(0, 8) + '...';

    // Basic info line
    console.log(`  ${statusIcon} ${name} │ ${status} │ ${uptime.padEnd(12)} │ ${appId}`);

    // Display URLs
    if (cvm.hosted.app_url) {
      console.log(`     └─ 🔗 ${cvm.hosted.app_url}`);
    }

    if (cvm.dapp_dashboard_url && cvm.hosted.status === 'running') {
      console.log(`     └─ 📊 Dashboard: ${cvm.dapp_dashboard_url}`);
    }

    // Health check if running
    if (cvm.hosted.status === 'running' && cvm.hosted.app_url) {
      try {
        const healthStatus = await this.checkCVMHealth(cvm.hosted.app_url);

        if (healthStatus.containers && healthStatus.containers.length > 0) {
          console.log(`     └─ 📦 Containers:`);
          healthStatus.containers.forEach(container => {
            const nameFormatted = container.name.padEnd(30);
            console.log(`        ${container.statusIcon} ${nameFormatted} │ ${container.status}`);
          });
        } else {
          if (healthStatus.success) {
            console.log(`     └─ 💚 Health: ${healthStatus.message}`);
          } else {
            console.log(`     └─ 💔 Health: ${healthStatus.message}`);
          }
        }
      } catch (error) {
        console.log(`     └─ ⚠️  Health check failed: ${error.message}`);
      }
    }
  }

  // Check CVM health via HTTP request
  async checkCVMHealth(url) {
    const https = require('https');
    const http = require('http');

    return new Promise((resolve) => {
      const urlObj = new URL(url.replace('dstack-eth-prod6.phala.network', 'dstack-pha-prod6.phala.network'));
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: '/', // Get the main dashboard page
        method: 'GET',
        timeout: 10000,
        rejectUnauthorized: false
      };

      const client = urlObj.protocol === 'https:' ? https : http;

      const req = client.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 200) {
            // Parse HTML to extract container status
            const containerStatus = this.parseContainerStatus(data);
            resolve(containerStatus);
          } else {
            resolve({ success: false, message: `HTTP ${res.statusCode}` });
          }
        });
      });

      req.on('error', () => {
        resolve({ success: false, message: 'Connection failed' });
      });

      req.setTimeout(10000, () => {
        req.destroy();
        resolve({ success: false, message: 'Timeout' });
      });

      req.end();
    });
  }

  // Parse HTML to extract container health status
  parseContainerStatus(html) {
    try {
      // Extract container rows from the table
      const tableRegex = /<tbody>(.*?)<\/tbody>/s;
      const tableMatch = html.match(tableRegex);

      if (!tableMatch) {
        return { success: false, message: 'No container table found', containers: [] };
      }

      const tbody = tableMatch[1];
      const rowRegex = /<tr>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>/g;
      const containers = [];
      let match;

      while ((match = rowRegex.exec(tbody)) !== null) {
        const name = match[1].trim();
        const status = match[2].trim();

        // Determine container health
        let isHealthy = false;
        let statusIcon = '🔴';

        if (status.includes('Up')) {
          if (status.includes('(healthy)') || name === 'app') {
            isHealthy = true;
            statusIcon = '💚';
          } else {
            statusIcon = '🟡'; // Up but not explicitly healthy
          }
        } else if (status.includes('Exited (0)')) {
          // Exited with success code (like setup containers)
          statusIcon = '✅';
          isHealthy = true;
        }

        containers.push({
          name,
          status,
          isHealthy,
          statusIcon
        });
      }

      if (containers.length === 0) {
        return { success: false, message: 'No containers found', containers: [] };
      }

      // Overall health assessment
      const healthyCount = containers.filter(c => c.isHealthy).length;
      const upCount = containers.filter(c => c.status.includes('Up')).length;
      const totalCount = containers.length;

      const overallHealthy = healthyCount === containers.filter(c => !c.status.includes('Exited') || c.status.includes('Exited (0)')).length;

      return {
        success: overallHealthy,
        message: `${upCount}/${totalCount} containers running`,
        containers: containers
      };

    } catch (error) {
      return { success: false, message: 'Failed to parse status', containers: [] };
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

    log.info(`App name: ${appName}, deployment directory: ${this.deploymentsDir}`);
    // Create deployment directory for the app
    const deploymentDir = path.join(this.deploymentsDir, appName);
    log.info(`Deployment directory: ${deploymentDir}`);
    if (!fs.existsSync(deploymentDir)) {
      fs.mkdirSync(deploymentDir, { recursive: true });
    }

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

    // Read all deployment configs to get app_ids
    const deploymentConfigs = [];
    if (fs.existsSync(this.deploymentsDir)) {
      const deployments = fs.readdirSync(this.deploymentsDir);

      for (const deploymentName of deployments) {
        const deploymentInfoPath = path.join(this.deploymentsDir, deploymentName, 'deployment-info.json');
        const deploymentDir = path.join(this.deploymentsDir, deploymentName);

        // Try to read our deployment info file first
        if (fs.existsSync(deploymentInfoPath)) {
          try {
            const infoContent = fs.readFileSync(deploymentInfoPath, 'utf8');
            const info = JSON.parse(infoContent);
            deploymentConfigs.push({
              name: deploymentName,
              app_id: info.app_id,
              vm_uuid: info.vm_uuid,
              deploymentDir
            });
            continue;
          } catch (error) {
            log.warn(`Failed to read deployment info for ${deploymentName}: ${error.message}`);
          }
        }

        // Fallback to reading phala config if our info file doesn't exist
        const configPath = path.join(deploymentDir, '.phala', 'config');
        if (fs.existsSync(configPath)) {
          try {
            const configContent = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(configContent);
            deploymentConfigs.push({
              name: deploymentName,
              vm_uuid: config.cvmUuid,
              app_id: null, // Will need to fetch from CVM list
              deploymentDir
            });
          } catch (error) {
            log.warn(`Failed to read config for ${deploymentName}: ${error.message}`);
          }
        }
      }
    }

    if (deploymentConfigs.length === 0) {
      log.info('No deployment configurations found');
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

        try {
          // Delete the CVM using phala CLI with the correct app_id
          await cloudCli('cvms', 'delete', appId, '--force');

          log.success(`✓ Deleted ${config.name}`);
          successCount++;
        } finally {
          process.chdir(originalDir);
        }

        // Remove or keep deployment directory based on flag
        if (removeDeploymentDir) {
          try {
            fs.rmSync(config.deploymentDir, { recursive: true, force: true });
            log.debug(`Removed deployment directory: ${config.deploymentDir}`);
          } catch (error) {
            log.warn(`Failed to remove deployment directory: ${error.message}`);
          }
        } else {
          log.debug(`Keeping deployment directory: ${config.deploymentDir}`);
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