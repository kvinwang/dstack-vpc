#!/usr/bin/env node
/**
 * Unified metrics aggregator for VPC server and client
 * Aggregates Headscale, Tailscale, and VPC connectivity metrics
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');

const METRICS_PORT = process.env.METRICS_PORT || 9090;
const VPC_SERVER_CONTAINER = process.env.VPC_SERVER_CONTAINER || 'dstack-vpc-server';
const VPC_CLIENT_CONTAINER = process.env.VPC_CLIENT_CONTAINER || 'dstack-vpc-client';
const PING_METRICS_FILE = process.env.PING_METRICS_FILE || '/shared/vpc_connectivity_metrics.txt';
const ROLE = process.env.ROLE || 'both'; // server, client, or both

/**
 * Check if a Docker container is running
 */
function isContainerRunning(containerName) {
  try {
    const output = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf-8' });
    return output.split('\n').includes(containerName);
  } catch (error) {
    return false;
  }
}

/**
 * Get Headscale metrics
 */
function getHeadscaleMetrics() {
  if (!['server', 'both'].includes(ROLE)) {
    return '';
  }

  if (!isContainerRunning(VPC_SERVER_CONTAINER)) {
    return '';
  }

  try {
    const metrics = execSync(
      `docker exec ${VPC_SERVER_CONTAINER} wget -q -O - http://localhost:9090/metrics`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return `# Headscale metrics\n${metrics}\n`;
  } catch (error) {
    return '# Headscale metrics unavailable\n';
  }
}

/**
 * Get Tailscale metrics
 */
function getTailscaleMetrics() {
  if (!['client', 'both'].includes(ROLE)) {
    return '';
  }

  if (!isContainerRunning(VPC_CLIENT_CONTAINER)) {
    return '';
  }

  try {
    const metrics = execSync(
      `docker exec ${VPC_CLIENT_CONTAINER} tailscale debug metrics`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return `# Tailscale metrics\n${metrics}\n`;
  } catch (error) {
    return '# Tailscale metrics unavailable\n';
  }
}

/**
 * Get VPC connectivity metrics
 */
function getVpcConnectivityMetrics() {
  if (!['client', 'both'].includes(ROLE)) {
    return '';
  }

  try {
    if (!fs.existsSync(PING_METRICS_FILE)) {
      return '# Ping metrics file not found\n';
    }

    const stats = fs.statSync(PING_METRICS_FILE);
    if (stats.size === 0) {
      return '# No ping metrics available yet\n';
    }

    // File is already in Prometheus format, just read and return
    return fs.readFileSync(PING_METRICS_FILE, 'utf-8');
  } catch (error) {
    return '# Error reading ping metrics\n';
  }
}

/**
 * Aggregate all metrics
 */
function aggregateMetrics() {
  const parts = [];

  const headscaleMetrics = getHeadscaleMetrics();
  if (headscaleMetrics) {
    parts.push(headscaleMetrics);
  }

  const tailscaleMetrics = getTailscaleMetrics();
  if (tailscaleMetrics) {
    parts.push(tailscaleMetrics);
  }

  const vpcMetrics = getVpcConnectivityMetrics();
  if (vpcMetrics) {
    parts.push(vpcMetrics);
  }

  return parts.join('\n');
}

/**
 * HTTP server
 */
const server = http.createServer((req, res) => {
  if (req.url === '/metrics' || req.url === '/') {
    try {
      const metrics = aggregateMetrics();
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4',
        'Content-Length': Buffer.byteLength(metrics)
      });
      res.end(metrics);
    } catch (error) {
      console.error('Error generating metrics:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error\n');
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  }
});

server.listen(METRICS_PORT, '0.0.0.0', () => {
  console.log(`Unified metrics aggregator listening on port ${METRICS_PORT} (role: ${ROLE})`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
