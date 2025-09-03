use load_config::load_config;
use rocket::figment::Figment;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Config {
    pub auth: AuthConfig,
    pub client: ClientConfig,
    pub agent: AgentConfig,
    pub tls: TlsConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuthConfig {
    pub address: IpAddr,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ClientConfig {
    pub address: IpAddr,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AgentConfig {
    pub gateway_domain: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TlsConfig {
    pub cert_file: String,
    pub key_file: String,
    pub ca_file: String,
}

/// Target information extracted from headers
#[derive(Debug, Clone)]
pub struct TargetInfo {
    pub app_id: String,
    pub instance_id: String,
    pub port: u16,
}

pub const DEFAULT_CONFIG: &str = include_str!("../dstack-mesh.toml");

pub fn load_config_figment(config_file: Option<&str>) -> Figment {
    load_config("mesh-proxy", DEFAULT_CONFIG, config_file, false)
}
