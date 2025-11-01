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

// Execute phala CLI commands
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

// Ensure directory exists (creates if missing)
function ensureDir(dirPath) {
  const fs = require('fs');
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Read JSON file safely
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

// Write JSON file safely
function writeJsonFile(filePath, data) {
  const fs = require('fs');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Extract JSON from CLI output (handles mixed output with status messages)
function extractJsonFromCliOutput(output) {
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}');

  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`No JSON found in output: ${output.substring(0, 100)}...`);
  }

  const jsonString = output.substring(jsonStart, jsonEnd + 1);
  return JSON.parse(jsonString);
}

// Format CVM with health check (returns array of strings)
function formatCVMWithHealth(cvm, healthStatus) {
  const lines = [];
  const statusIcon = cvm.status === 'running' ? '✅' :
    cvm.status === 'stopped' ? '🔴' : '⚠️';

  const name = cvm.deploymentName.padEnd(25);
  const status = cvm.status.padEnd(10);
  const uptime = cvm.hosted?.uptime || 'N/A';
  const appId = cvm.app_id.substring(0, 8) + '...';

  // Basic info line
  lines.push(`  ${statusIcon} ${name} │ ${status} │ ${uptime.padEnd(12)} │ ${appId}`);

  // Display URLs
  if (cvm.dapp_dashboard_url && cvm.status === 'running') {
    lines.push(`     └─ 📊 Dashboard: ${cvm.dapp_dashboard_url}`);
  }

  // Health check if running
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

// Display CVM with health check (legacy method for compatibility)
async function displayCVMWithHealth(cvm, checkHealthFunc) {
  const statusIcon = cvm.status === 'running' ? '✅' :
    cvm.status === 'stopped' ? '🔴' : '⚠️';

  const name = cvm.deploymentName.padEnd(25);
  const status = cvm.status.padEnd(10);
  const uptime = cvm.hosted?.uptime || 'N/A';
  const appId = cvm.app_id.substring(0, 8) + '...';

  // Basic info line
  console.log(`  ${statusIcon} ${name} │ ${status} │ ${uptime.padEnd(12)} │ ${appId}`);

  // Display URLs
  if (cvm.dapp_dashboard_url && cvm.status === 'running') {
    console.log(`     └─ 📊 Dashboard: ${cvm.dapp_dashboard_url}`);
  }

  // Health check if running
  if (cvm.status === 'running' && cvm.dapp_dashboard_url && checkHealthFunc) {
    try {
      const healthStatus = await checkHealthFunc(cvm.dapp_dashboard_url);

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
async function checkCVMHealth(url) {
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

// Parse HTML to extract container health status
function parseContainerStatus(html) {
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

module.exports = {
  colors,
  log,
  cloudCli,
  ensureDir,
  readJsonFile,
  writeJsonFile,
  extractJsonFromCliOutput,
  formatCVMWithHealth,
  displayCVMWithHealth,
  checkCVMHealth,
  parseContainerStatus
};
