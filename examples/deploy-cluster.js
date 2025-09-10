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
  const command = 'node';
  const fullArgs = ['/home/kvin/codes/dstack-vpc/phala-cloud-cli/dist/index.js', ...args];
  
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
        node: "prod6-eth"
      },
      mongodb_nodes: [
        {
          name: "mongodb-0",
          cpu: 2,
          memory: "8G",
          storage: "200G",
          node: "prod6-eth"
        },
        {
          name: "mongodb-1",
          cpu: 2,
          memory: "8G",
          storage: "200G",
          node: "prod6-eth"
        },
        {
          name: "mongodb-2",
          cpu: 2,
          memory: "8G",
          storage: "200G",
          node: "prod6-eth"
        }
      ],
      "test-app": {
        cpu: 1,
        memory: "2G",
        storage: "20G",
        node: "prod6-eth"
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
    const deploymentDir = path.join(this.deploymentsDir, config.name);
    if (!fs.existsSync(deploymentDir)) {
      fs.mkdirSync(deploymentDir, { recursive: true });
    }

    // Copy compose file to deployment directory
    const sourceCompose = config.composeFile;
    const targetCompose = path.join(deploymentDir, path.basename(config.composeFile));

    if (!fs.existsSync(sourceCompose)) {
      throw new Error(`Compose file not found: ${sourceCompose}`);
    }

    fs.copyFileSync(sourceCompose, targetCompose);

    log.debug('Deployment parameters:');
    log.debug(`  Name: ${config.name}, vCPU: ${config.cpu}, Memory: ${config.memory}`);
    log.debug(`  Disk: ${config.storage}, Node: ${config.node} (ID: ${nodeId})`);
    log.debug(`  KMS: ${this.config.kms}, Image: ${this.config.os_image}`);

    const args = [
      '--json',  // Add JSON output flag
      '--compose', path.basename(targetCompose),
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

      return appId;
    } catch (error) {
      log.error(`Deployment failed: ${error.message}`);
      throw error;
    }
  }

  // Deploy VPC Server
  async deployVPCServer() {
    log.info('Deploying VPC server...');
    const vpcConfig = this.config.vpc_server;
    const composeFile = path.join(this.scriptDir, 'vpc-server.yaml');
    const appId = await this.deployWithConfig({
      composeFile,
      ...vpcConfig
    });

    // Save VPC server ID for later use
    fs.writeFileSync(this.vpcServerIdFile, appId);

    return appId;
  }

  // Deploy MongoDB node
  async deployMongoDBNode(index, vpcServerId) {
    const nodeConfig = this.config.mongodb_nodes[index];
    const composeFile = path.join(this.scriptDir, 'mongodb.yaml');

    log.info(`Deploying MongoDB node: ${nodeConfig.name}...`);

    // Create deployment directory first
    const deploymentDir = path.join(this.deploymentsDir, nodeConfig.name);
    if (!fs.existsSync(deploymentDir)) {
      fs.mkdirSync(deploymentDir, { recursive: true });
    }

    // Write env file directly to deployment directory
    const envFile = path.join(deploymentDir, `.envfile`);
    const envContent = `MONGO_IND=${index}\nVPC_SERVER_APP_ID=${vpcServerId}`;
    fs.writeFileSync(envFile, envContent);

    try {
      const appId = await this.deployWithConfig({
        ...nodeConfig,
        composeFile,
        envFile: envFile  // Pass the actual path, deployWithConfig will handle it
      });

      return appId;
    } catch (error) {
      throw error;
    }
  }

  // Wait for health check
  async waitForHealth(appId, name) {
  }

  // Deploy cluster
  async deployCluster() {
    await this.checkAuth();
    this.loadConfig();

    log.info('Starting MongoDB cluster deployment...\n');

    try {
      // Step 1: Deploy VPC server
      log.info('Step 1/4: Deploying VPC server...');
      const vpcServerId = await this.deployVPCServer();
      console.log();

      // Step 2-4: Deploy MongoDB nodes
      const mongodbAppIds = [];
      for (let i = 0; i < 3; i++) {
        log.info(`Step ${i + 2}/4: Deploying MongoDB node ${i}...`);
        const appId = await this.deployMongoDBNode(i, vpcServerId);
        mongodbAppIds.push(appId);
        console.log();
      }

      // Success summary
      log.success('✅ MongoDB cluster deployment complete!\n');
      console.log('Deployment summary:');
      console.log(`  VPC Server App ID: ${vpcServerId}`);
      mongodbAppIds.forEach((id, i) => {
        console.log(`  MongoDB-${i} App ID: ${id}`);
      });
      console.log('\nDeployment files:');
      console.log(`  Deployment directories: ${this.deploymentsDir}`);
      console.log(`  VPC Server ID file: ${this.vpcServerIdFile}`);
      console.log('  Each deployment has its own isolated .phala/config');
      console.log('\nMongoDB cluster is ready for connections!');

    } catch (error) {
      log.error(`Deployment failed: ${error.message}`);
      if (process.env.DEBUG) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  }

  // Deploy test app
  async deployApp() {
    await this.checkAuth();
    this.loadConfig();

    // Check if VPC server exists
    if (!fs.existsSync(this.vpcServerIdFile)) {
      log.error('VPC server ID not found. Please deploy the cluster first using: deploy-cluster');
      process.exit(1);
    }

    const vpcServerId = fs.readFileSync(this.vpcServerIdFile, 'utf8').trim();
    log.info(`Using VPC Server App ID: ${vpcServerId}`);

    const appConfig = this.config['test-app'];
    const composeFile = path.join(this.scriptDir, 'mongo-app.yaml');
    const appIndex = Math.floor(Math.random() * 100);
    const appName = `mongodb-demo-app-${appIndex}`;

    log.info('Deploying demo application...');

    // Create deployment directory for the app
    const deploymentDir = path.join(this.deploymentsDir, appName);
    if (!fs.existsSync(deploymentDir)) {
      fs.mkdirSync(deploymentDir, { recursive: true });
    }

    // Write env file directly to deployment directory
    const envFile = path.join(deploymentDir, `.envfile`);
    const envContent = `APP_IND=${appIndex}\nVPC_SERVER_APP_ID=${vpcServerId}`;
    fs.writeFileSync(envFile, envContent);

    try {
      const appId = await this.deployWithConfig({
        ...appConfig,
        name: appName,
        composeFile,
        envFile: envFile
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
}

// Main execution
async function main() {
  const deployer = new PhalaDeployer();
  const command = process.argv[2];

  switch (command) {
    case 'deploy-cluster':
      await deployer.deployCluster();
      break;
    case 'deploy-app':
      await deployer.deployApp();
      break;
    default:
      console.log('Usage: node deploy-cluster.js {deploy-cluster|deploy-app}');
      console.log('\nCommands:');
      console.log('  deploy-cluster  Deploy VPC server and MongoDB cluster (3 nodes)');
      console.log('  deploy-app      Deploy demo application (requires cluster to be deployed first)');
      console.log('\nEnvironment variables:');
      console.log('  DEBUG=1         Enable debug output');
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