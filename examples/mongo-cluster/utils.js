const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

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

async function cloudCli(...args) {
  const { spawn } = require('child_process');
  const command = 'phala';
  const fullArgs = [...args];

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
        reject(new Error(`Command failed with exit code ${code}\n${errorOutput}\nCommand line: ${command} ${fullArgs.join(' ')}`));
      } else {
        resolve(output.trim());
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}

function ensureDir(dirPath) {
  const fs = require('fs');
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJsonFile(filePath) {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    log.warn(`Failed to read JSON from ${filePath}: ${error.message}`);
    return null;
  }
}

function writeJsonFile(filePath, data) {
  const fs = require('fs');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function extractJsonFromCliOutput(output) {
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}');

  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`No JSON found in output: ${output.substring(0, 100)}...`);
  }

  const jsonString = output.substring(jsonStart, jsonEnd + 1);
  return JSON.parse(jsonString);
}

function extractJsonArrayFromCliOutput(output) {
  try {
    return JSON.parse(output);
  } catch (parseError) {
    const startIndex = output.indexOf('[');
    if (startIndex !== -1) {
      const jsonPart = output.substring(startIndex);
      return JSON.parse(jsonPart);
    }
    throw new Error('Failed to parse JSON array from CLI output');
  }
}

function renderFile(srcFile, dstFile, variables = {}) {
  const fs = require('fs');
  let content = fs.readFileSync(srcFile, 'utf8');

  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
    content = content.replace(pattern, value);
  }

  fs.writeFileSync(dstFile, content);
}

function renderCompose(srcFile, deploymentDir, variables = {}) {
  const path = require('path');
  const dstFile = path.join(deploymentDir, "docker-compose.yml");
  renderFile(srcFile, dstFile, variables);
  return dstFile;
}

function renderClusterStatus(statusData) {
  if (statusData.isEmpty) {
    if (statusData.reason === 'no_cvms') {
      return 'No matching CVMs found';
    }
    return 'No deployment configurations found';
  }

  const lines = [];

  lines.push('\n📊 MongoDB Cluster Status\n');
  lines.push('═'.repeat(80));

  // Display VPC Server
  if (statusData.vpcServer) {
    lines.push('🌐 VPC Server:');
    lines.push(...formatCVMWithHealth(
      statusData.vpcServer,
      statusData.healthMap.get(statusData.vpcServer.deploymentName)
    ));
    lines.push('');
  }

  // Display MongoDB Nodes
  if (statusData.mongoNodes.length > 0) {
    lines.push('🗄️  MongoDB Cluster Nodes:');
    for (const cvm of statusData.mongoNodes) {
      lines.push(...formatCVMWithHealth(cvm, statusData.healthMap.get(cvm.deploymentName)));
    }
    lines.push('');
  }

  // Display Demo Apps
  if (statusData.demoApps.length > 0) {
    lines.push('🚀 Demo Applications:');
    for (const cvm of statusData.demoApps) {
      lines.push(...formatCVMWithHealth(cvm, statusData.healthMap.get(cvm.deploymentName)));
    }
    lines.push('');
  }

  // Summary
  lines.push('═'.repeat(80));
  lines.push(`📈 Summary: ${statusData.summary.running}/${statusData.summary.total} nodes running`);

  if (statusData.summary.allHealthy) {
    lines.push('✅ All cluster nodes are healthy!');
  } else {
    lines.push('⚠️  Some nodes need attention');
  }

  return lines.join('\n');
}

function formatCVMWithHealth(cvm, healthStatus) {
  const lines = [];
  const statusIcon = cvm.status === 'running' ? '✅' :
    cvm.status === 'stopped' ? '🔴' : '⚠️';

  const name = cvm.deploymentName.padEnd(25);
  const status = cvm.status.padEnd(10);
  const uptime = cvm.hosted?.uptime || 'N/A';
  const appId = cvm.app_id.substring(0, 8) + '...';

  lines.push(`  ${statusIcon} ${name} │ ${status} │ ${uptime.padEnd(12)} │ ${appId}`);

  if (cvm.dapp_dashboard_url && cvm.status === 'running') {
    lines.push(`     └─ 📊 Dashboard: ${cvm.dapp_dashboard_url}`);
  }

  if (cvm.status === 'running' && healthStatus) {
    if (healthStatus.containers && healthStatus.containers.length > 0) {
      lines.push(`     └─ 📦 Containers:`);
      healthStatus.containers.forEach(container => {
        const nameFormatted = container.name.padEnd(30);
        lines.push(`        ${container.statusIcon} ${nameFormatted} │ ${container.status}`);
      });
    } else {
      if (healthStatus.success) {
        lines.push(`     └─ 💚 Health: ${healthStatus.message}`);
      } else {
        lines.push(`     └─ 💔 Health: ${healthStatus.message}`);
      }
    }
  }

  return lines;
}

async function checkCVMHealth(url) {
  const https = require('https');

  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: '/',
      method: 'GET',
      timeout: 10000,
      rejectUnauthorized: false
    };

    const client = https;

    const req = client.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          const containerStatus = parseContainerStatus(data);
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

function parseContainerStatus(html) {
  try {
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

      let isHealthy = false;
      let statusIcon = '🔴';

      if (status.includes('Up')) {
        if (status.includes('(healthy)') || name === 'app') {
          isHealthy = true;
          statusIcon = '💚';
        } else {
          statusIcon = '🟡';
        }
      } else if (status.includes('Exited (0)')) {
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

module.exports = {
  colors,
  log,
  cloudCli,
  ensureDir,
  readJsonFile,
  writeJsonFile,
  extractJsonFromCliOutput,
  extractJsonArrayFromCliOutput,
  renderFile,
  renderCompose,
  renderClusterStatus,
  formatCVMWithHealth,
  checkCVMHealth,
  parseContainerStatus
};
