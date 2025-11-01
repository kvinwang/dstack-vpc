#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { log, cloudCli, ensureDir, readJsonFile, writeJsonFile, checkCVMHealth, extractJsonFromCliOutput, extractJsonArrayFromCliOutput, renderCompose, renderClusterStatus } = require('./utils');

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

  loadConfig() {
    this.config = readJsonFile(this.configFile);
    if (!this.config) {
      log.error(`Configuration file not found: ${this.configFile}`);
      log.error('Please create deployment-config.json before deploying');
      process.exit(1);
    }
    log.info(`Loaded configuration from: ${this.configFile}`);
  }

  async checkAuth() {
    log.info('Checking authentication status...');
    await cloudCli('auth', 'status');
    log.success('Authentication verified ✓');
  }

  async executeDeploy(args, workingDir = null) {
    const originalCwd = process.cwd();
    try {
      if (workingDir) {
        log.debug(`Working directory: ${workingDir}`);
        process.chdir(workingDir);
      }
      const output = await cloudCli('deploy', ...args);
      return output;
    } finally {
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

    log.debug('Deployment parameters:');
    log.debug(`  Name: ${config.name}, vCPU: ${config.cpu}, Memory: ${config.memory}`);
    log.debug(`  Disk: ${config.storage}, Node: ${config.node} (ID: ${nodeId})`);
    log.debug(`  KMS: ${kms}, Image: ${this.config.os_image}`);

    if (!config.composeFile.startsWith('/')) {
      config.composeFile = path.join(this.scriptDir, config.composeFile);
    }
    const staticEnvs = config.staticEnvs || {};
    const renderedComposeFile = renderCompose(config.composeFile, deploymentDir, staticEnvs);

    const args = [
      '--json',
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

      const jsonResult = extractJsonFromCliOutput(output);
      log.debug('JSON Response:');
      log.debug(JSON.stringify(jsonResult, null, 2));

      if (!jsonResult.success) {
        throw new Error(`Deployment failed: ${jsonResult.error || 'Unknown error'}`);
      }

      const appId = jsonResult.app_id;
      if (!appId) {
        throw new Error('Failed to extract App ID from deployment output');
      }

      log.success(`Deployed ${jsonResult.name} with App ID: ${appId}`);

      if (jsonResult.vm_uuid) {
        log.info(`VM UUID: ${jsonResult.vm_uuid}`);
      }
      if (jsonResult.dashboard_url) {
        log.info(`Dashboard: ${jsonResult.dashboard_url}`);
      }


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

  async deployNode(index, vpcServerId) {
    const nodeConfig = this.config.nodes[index];
    log.info(`Deploying node: ${nodeConfig.name}...`);

    const deploymentDir = path.join(this.deploymentsDir, nodeConfig.name);
    ensureDir(deploymentDir);

    const nodeInd = nodeConfig.index;
    if (nodeInd === undefined) {
      throw new Error(`Node index is not defined for node: ${nodeConfig.name}`);
    }
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

  async deployStep1() {
    await this.checkAuth();
    this.loadConfig();

    log.info('Step 1: Deploying VPC server with dummy container...');

    const appId = await this.deployWithConfig({
      ...this.config.vpc_server,
      staticEnvs: {
        VPC_ALLOWED_APPS: 'any',
      }
    });

    fs.writeFileSync(this.vpcServerIdFile, appId);

    log.success('Step 1 completed: VPC server deployed with dummy container');
    log.info(`VPC Server App ID: ${appId}`);

    return appId;
  }

  async deployStep2() {
    await this.checkAuth();
    this.loadConfig();

    log.info('Step 2: Deploying MongoDB nodes...');

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

    const nodeIdsFile = path.join(this.deploymentsDir, '.mongo_node_ids');
    fs.writeFileSync(nodeIdsFile, nodeAppIds.join(','));

    log.success('Step 2 completed: All MongoDB nodes deployed');
    log.info(`MongoDB Node App IDs: ${nodeAppIds.join(', ')}`);

    return nodeAppIds;
  }

  async deployStep3() {
    this.loadConfig();

    log.info('Step 3: Redeploying VPC server with correct configuration...');

    const nodeIdsFile = path.join(this.deploymentsDir, '.mongo_node_ids');
    if (!fs.existsSync(nodeIdsFile)) {
      log.error('MongoDB node IDs not found. Please run step 2 first: node deploy.js step2');
      process.exit(1);
    }

    const mongoNodeIds = fs.readFileSync(nodeIdsFile, 'utf8').trim().split(',');
    log.info(`MongoDB Node App IDs: ${mongoNodeIds.join(', ')}`);

    if (!fs.existsSync(this.vpcServerIdFile)) {
      log.error('VPC server not found. Cannot redeploy without existing VPC server.');
      process.exit(1);
    }

    const currentVpcAppId = fs.readFileSync(this.vpcServerIdFile, 'utf8').trim();
    log.info(`Current VPC Server App ID: ${currentVpcAppId}`);

    const allowedApps = mongoNodeIds.join(',');
    const vpcDeploymentDir = path.join(this.deploymentsDir, this.config.vpc_server.name);
    const sourceCompose = path.join(this.scriptDir, this.config.vpc_server.composeFile);
    const targetCompose = renderCompose(sourceCompose, vpcDeploymentDir, {
      VPC_ALLOWED_APPS: allowedApps
    });

    log.info('Upgrading VPC server with updated configuration...');
    log.info(`Setting VPC_ALLOWED_APPS to: ${allowedApps}`);

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

    const appId = currentVpcAppId;

    log.success('Step 3 completed: VPC server redeployed with correct configuration');
    log.info(`VPC Server App ID: ${appId}`);
    log.info(`VPC_ALLOWED_APPS: ${allowedApps}`);

    return appId;
  }

  async deployCluster() {
    log.info('Starting complete MongoDB cluster deployment...');
    log.info('This will execute all three steps automatically\n');

    try {
      await this.deployStep1();
      log.info('');

      await this.deployStep2();
      log.info('');

      console.log('\n' + '═'.repeat(80));
      log.success('🎉 Complete MongoDB cluster deployment finished!');
      console.log('═'.repeat(80));

    } catch (error) {
      log.error(`Cluster deployment failed: ${error.message}`);
      process.exit(1);
    }
  }

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

  async getClusterStatusData() {
    // 1. Read all deployment configs
    const deployments = [];
    if (fs.existsSync(this.deploymentsDir)) {
      const dirs = fs.readdirSync(this.deploymentsDir).filter(name => !name.startsWith('.'));
      for (const name of dirs) {
        const state = this.getDeploymentState(name);
        if (state && state.app_id) {
          deployments.push({ name, app_id: state.app_id, vm_uuid: state.vm_uuid });
        } else if (state && state.status === 'deploying') {
          // Deployment still in progress or failed
        }
      }
    }

    if (deployments.length === 0) {
      return { isEmpty: true, reason: 'no_deployments' };
    }

    // 2. Fetch CVM data for all deployments
    const cvms = await this.fetchCVMs(deployments, true);

    if (cvms.length === 0) {
      return { isEmpty: true, reason: 'no_cvms' };
    }

    // 3. Fetch health data for all running CVMs (in parallel would be better, but keep it simple)
    const healthMap = new Map();
    for (const cvm of cvms) {
      if (cvm.status === 'running' && cvm.dapp_dashboard_url) {
        healthMap.set(cvm.deploymentName, await checkCVMHealth(cvm.dapp_dashboard_url));
      }
    }

    // 4. Categorize CVMs by type
    const vpcServer = cvms.find(cvm => cvm.deploymentName.includes('vpc-server'));
    const mongoNodes = cvms
      .filter(cvm => cvm.deploymentName.match(/^mongodb-[0-9]+$/))
      .sort((a, b) => a.deploymentName.localeCompare(b.deploymentName));
    const demoApps = cvms.filter(cvm =>
      cvm.deploymentName.includes('app') ||
      (cvm.deploymentName.includes('mongodb') && !cvm.deploymentName.match(/^mongodb-[0-9]+$/) && !cvm.deploymentName.includes('vpc-server'))
    );

    // 5. Calculate summary statistics
    const totalNodes = cvms.length;
    const runningNodes = cvms.filter(cvm => cvm.status === 'running').length;
    const allHealthy = runningNodes === totalNodes;

    return {
      isEmpty: false,
      vpcServer,
      mongoNodes,
      demoApps,
      healthMap,
      summary: {
        total: totalNodes,
        running: runningNodes,
        allHealthy
      }
    };
  }

  async showStatus(watch = false, interval = 5000) {
    await this.checkAuth();

    const showStatusOnce = async () => {
      try {
        if (!watch) {
          log.info('Scanning deployment configurations...');
          log.info('Fetching CVM status from Phala Cloud...');
        }

        const statusData = await this.getClusterStatusData();
        const renderedOutput = renderClusterStatus(statusData);

        if (watch) {
          console.clear();
          const now = new Date().toLocaleTimeString();
          console.log(`🔄 Auto-refreshing every ${interval / 1000}s | Last update: ${now}`);
          console.log('   Press Ctrl+C to stop\n');
        }
        console.log(renderedOutput);

      } catch (error) {
        console.error(error);
        log.error(`Failed to fetch cluster status: ${error.message}`);
      }
    };

    if (!watch) {
      await showStatusOnce();
    } else {
      process.on('SIGINT', () => {
        console.log('\n\n👋 Stopping status monitor...');
        process.exit(0);
      });

      while (true) {
        await showStatusOnce();
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
  }

  async deployApp() {
    await this.checkAuth();
    this.loadConfig();

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

  async teardown() {
    await this.checkAuth();

    console.log('\n⚠️  WARNING: This will delete all deployed CVMs for this cluster');
    console.log('═'.repeat(80));

    log.info('Scanning deployment configurations...');

    const deploymentConfigs = [];
    if (fs.existsSync(this.deploymentsDir)) {
      const deployments = fs.readdirSync(this.deploymentsDir).filter(name =>
        !name.startsWith('.')
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

    const needsFetch = deploymentConfigs.some(config => !config.app_id);
    let allCvms = null;

    if (needsFetch) {
      log.info('Fetching CVM list to get missing app IDs...');
      const listOutput = await cloudCli('cvms', 'list', '--json');
      try {
        allCvms = extractJsonArrayFromCliOutput(listOutput);
      } catch (e) {
        log.error('Failed to parse CVM list');
      }
    }

    for (const config of deploymentConfigs) {
      try {
        log.info(`Deleting ${config.name}...`);

        let appId = config.app_id;

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

        const originalDir = process.cwd();
        process.chdir(config.deploymentDir);

        let deleted = false;
        try {
          await cloudCli('cvms', 'delete', appId, '--force');
          log.success(`✓ Deleted ${config.name}`);
          deleted = true;
        } catch (error) {
          if (error.message.includes('not detected')) {
            log.success(`✓ ${config.name} (already deleted)`);
            deleted = true;
          } else {
            throw error;
          }
        } finally {
          process.chdir(originalDir);
        }

        if (deleted) {
          successCount++;

          try {
            fs.rmSync(config.deploymentDir, { recursive: true, force: true });
            log.debug(`Removed deployment directory: ${config.deploymentDir}`);
          } catch (error) {
            log.warn(`Failed to remove deployment directory: ${error.message}`);
          }
        }

      } catch (error) {
        log.error(`✗ Failed to delete ${config.name}: ${error.message}`);
        failCount++;
      }
    }

    if (fs.existsSync(this.vpcServerIdFile)) {
      fs.unlinkSync(this.vpcServerIdFile);
      log.debug('Removed VPC server ID file');
    }

    const nodeIdsFile = path.join(this.deploymentsDir, '.mongo_node_ids');
    if (fs.existsSync(nodeIdsFile)) {
      fs.unlinkSync(nodeIdsFile);
      log.debug('Removed mongo node IDs file');
    }

    if (fs.existsSync(this.deploymentsDir)) {
      try {
        const remainingDirs = fs.readdirSync(this.deploymentsDir);
        if (remainingDirs.length === 0) {
          fs.rmSync(this.deploymentsDir, { recursive: true, force: true });
          log.debug('Removed deployments directory');
        }
      } catch (error) {
        log.warn(`Failed to remove deployments directory: ${error.message}`);
      }
    }

    console.log('\n' + '═'.repeat(80));
    console.log(`📊 Teardown Summary:`);
    console.log(`   ✅ Successfully deleted: ${successCount}`);
    if (failCount > 0) {
      console.log(`   ❌ Failed to delete: ${failCount}`);
    }
    console.log(`   🗑️  Removed deployment directories`);

    if (successCount === deploymentConfigs.length) {
      console.log('\n✨ All CVMs successfully removed!');
    } else if (failCount > 0) {
      console.log('\n⚠️  Some CVMs could not be removed. Check logs for details.');
    }
  }
}

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
      const watchMode = args.includes('--watch') || args.includes('-w');
      let interval = 5000;

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
      await deployer.teardown();
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
      console.log('  down          Remove all deployed CVMs and clean up directories');
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

main().catch(error => {
  log.error(`Unexpected error: ${error.message}`);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});