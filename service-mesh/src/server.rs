use anyhow::{bail, Context, Result};
use ra_tls::traits::CertExt;
use rocket::figment::providers::Serialized;
use rocket::http::{Header, Status};
use rocket::request::{FromRequest, Outcome};
use rocket::response::Responder;
use rocket::response::Response;
use rocket::{get, routes, Request};
use tracing::{info, warn};

/// Custom responder that returns status with headers
pub struct AuthSuccessResponse {
    app_id: String,
}

impl<'r> Responder<'r, 'static> for AuthSuccessResponse {
    fn respond_to(self, _: &'r rocket::Request<'_>) -> rocket::response::Result<'static> {
        Response::build()
            .status(Status::Ok)
            .header(Header::new("x-dstack-app-id", self.app_id))
            .ok()
    }
}

/// Custom request guard for server auth headers
pub struct AuthHeaders {
    pub client_cert: Option<String>,
    pub client_verify: Option<String>,
}

#[rocket::async_trait]
impl<'r> FromRequest<'r> for AuthHeaders {
    type Error = ();

    async fn from_request(request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        let headers = request.headers();
        let client_cert = headers.get_one("x-client-cert").map(|s| s.to_string());
        let client_verify = headers.get_one("x-client-verify").map(|s| s.to_string());

        Outcome::Success(AuthHeaders {
            client_cert,
            client_verify,
        })
    }
}

/// Auth endpoint for nginx auth_request integration
#[get("/auth")]
async fn auth_handler(headers: AuthHeaders) -> Result<AuthSuccessResponse, Status> {
    // Extract client certificate from headers (passed by nginx)
    let cert_header = headers.client_cert.as_ref();
    let verify_header = headers.client_verify.as_ref();

    let Some(verify) = verify_header else {
        warn!("Missing verify header");
        return Err(Status::Unauthorized);
    };
    if verify != "SUCCESS" {
        warn!("Verify header is not SUCCESS");
        return Err(Status::Unauthorized);
    }
    let Some(cert_pem) = cert_header else {
        warn!("Missing cert header");
        return Err(Status::Unauthorized);
    };
    // Parse and verify certificate
    match parse_and_verify_cert(cert_pem).await {
        Ok(app_id) => {
            info!("Auth successful for app_id: {app_id}");
            Ok(AuthSuccessResponse { app_id })
        }
        Err(e) => {
            warn!("Auth failed: {e}");
            Err(Status::Unauthorized)
        }
    }
}

async fn parse_and_verify_cert(cert_pem: &str) -> Result<String> {
    let decoded = urlencoding::decode(cert_pem).context("Failed to decode certificate")?;
    let (_, ca_pem) =
        x509_parser::pem::parse_x509_pem(decoded.as_bytes()).context("Failed to parse ca cert")?;
    let cert = ca_pem.parse_x509().context("Failed to parse ca cert")?;
    let Some(app_id_bytes) = cert
        .get_app_id()
        .context("Failed to get app_id from client cert")?
    else {
        bail!("No app_id found in client cert");
    };
    Ok(hex::encode(app_id_bytes))
}

/// Health check endpoint
#[get("/health")]
fn health_handler() -> Status {
    Status::Ok
}

/// Run auth service with configuration from main figment
pub(crate) async fn run_auth_service(main_figment: &rocket::figment::Figment) -> Result<()> {
    // Create Rocket figment for auth service using the auth section
    let figment = rocket::figment::Figment::new()
        .merge(rocket::Config::default())
        .merge(Serialized::defaults(
            main_figment
                .find_value("auth")
                .context("auth section not found")?,
        ));

    let _rocket = rocket::custom(figment)
        .mount("/", routes![auth_handler, health_handler])
        .launch()
        .await
        .map_err(|e| anyhow::anyhow!("Rocket launch error: {}", e))?;

    Ok(())
}
