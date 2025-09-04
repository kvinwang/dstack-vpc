package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type Config struct {
	AllowedApps      []string
	AllowedNodeTypes []string
}

type NodeInfo struct {
	UUID        string  `json:"uuid"`
	Name        string  `json:"name"`
	NodeType    string  `json:"node_type"`
	TailscaleIP *string `json:"tailscale_ip"`
}

type BootstrapResponse struct {
	PreAuthKey   string `json:"pre_auth_key"`
	Keyfile      string `json:"keyfile"`
	HeadscaleURL string `json:"headscale_url"`
}

type NodesResponse struct {
	Nodes []NodeInfo `json:"nodes"`
}

type AppState struct {
	config       Config
	nodes        map[string]NodeInfo
	mutex        sync.RWMutex
	keyfile      string
	headscaleURL string
}

type DstackInfo struct {
	AppID string `json:"app_id"`
}

type GatewayInfo struct {
	GatewayDomain string `json:"gateway_domain"`
}

func getAppIDFromDstackMesh() (string, error) {
	resp, err := http.Get("http://dstack-mesh/info")
	if err != nil {
		return "", fmt.Errorf("failed to get app info: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("dstack-mesh Info returned status %d", resp.StatusCode)
	}

	var info DstackInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", fmt.Errorf("failed to decode app info: %w", err)
	}

	return info.AppID, nil
}

func getGatewayDomainFromDstackMesh() (string, error) {
	resp, err := http.Get("http://dstack-mesh/gateway")
	if err != nil {
		return "", fmt.Errorf("failed to get gateway info: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("dstack-mesh Gateway returned status %d", resp.StatusCode)
	}

	var info GatewayInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", fmt.Errorf("failed to decode gateway info: %w", err)
	}

	return info.GatewayDomain, nil
}

func buildHeadscaleURL() string {
	// Check for explicit configuration first
	if url := os.Getenv("HEADSCALE_URL"); url != "" {
		return url
	}

	// Try auto-detection with retries
	var appID, gatewayDomain string
	var err error

	for i := 0; i < 30; i++ {
		appID, err = getAppIDFromDstackMesh()
		if err == nil {
			break
		}
		log.Printf("Waiting for dstack-mesh to be ready... (%d/30)", i+1)
		time.Sleep(2 * time.Second)
	}

	if err != nil {
		log.Printf("Failed to get app_id after retries: %v, falling back to default", err)
		return "http://headscale:8080"
	}

	gatewayDomain, err = getGatewayDomainFromDstackMesh()
	if err != nil {
		log.Printf("Failed to get gateway_domain: %v, falling back to default", err)
		return "http://headscale:8080"
	}

	return fmt.Sprintf("https://%s-8080.%s", appID, gatewayDomain)
}

func parseAllowedApps(allowedApps string) []string {
	if allowedApps == "" {
		return []string{}
	}
	if allowedApps == "any" {
		return []string{"any"}
	}
	apps := strings.Split(allowedApps, ",")
	var result []string
	for _, app := range apps {
		if trimmed := strings.TrimSpace(app); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func (s *AppState) isAppAllowed(appID string) bool {
	for _, allowed := range s.config.AllowedApps {
		if allowed == "any" || allowed == appID {
			return true
		}
	}
	return false
}

type HeadscaleNode struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	User        string   `json:"user"`
	IPAddresses []string `json:"ipAddresses"`
	Online      bool     `json:"online"`
}

type PreAuthKeyRequest struct {
	User       string `json:"user"`
	Reusable   bool   `json:"reusable"`
	Ephemeral  bool   `json:"ephemeral"`
	Expiration string `json:"expiration"`
}

type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type UsersResponse struct {
	Users []User `json:"users"`
}

type PreAuthKeyData struct {
	Key string `json:"key"`
}

type PreAuthKeyResponse struct {
	PreAuthKey PreAuthKeyData `json:"preAuthKey"`
}

func getAPIKey() (string, error) {
	// Try environment variable first
	if apiKey := os.Getenv("HEADSCALE_API_KEY"); apiKey != "" {
		return apiKey, nil
	}

	// Try reading from shared file
	keyBytes, err := os.ReadFile("/data/api_key")
	if err != nil {
		return "", fmt.Errorf("failed to read API key from file: %w", err)
	}

	return strings.TrimSpace(string(keyBytes)), nil
}

func getHeadscaleAPIURL() string {
	if url := os.Getenv("HEADSCALE_API_URL"); url != "" {
		return url
	}
	return "http://headscale:8080"
}

func getUserID(username string) (string, error) {
	apiKey, err := getAPIKey()
	if err != nil {
		return "", err
	}

	client := &http.Client{}
	req, err := http.NewRequest("GET", getHeadscaleAPIURL()+"/api/v1/user", nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("headscale API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("headscale API returned status %d: %s", resp.StatusCode, string(body))
	}

	var usersResp UsersResponse
	if err := json.NewDecoder(resp.Body).Decode(&usersResp); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	for _, user := range usersResp.Users {
		if user.Name == username {
			return user.ID, nil
		}
	}

	return "", fmt.Errorf("user %s not found", username)
}

func generatePreAuthKey() (string, error) {
	apiKey, err := getAPIKey()
	if err != nil {
		return "", err
	}

	userID, err := getUserID("default")
	if err != nil {
		return "", fmt.Errorf("failed to get user ID: %w", err)
	}

	expiration := time.Now().Add(24 * time.Hour).Format(time.RFC3339)

	reqBody := PreAuthKeyRequest{
		User:       userID,
		Reusable:   true,
		Ephemeral:  false,
		Expiration: expiration,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	client := &http.Client{}
	req, err := http.NewRequest("POST", getHeadscaleAPIURL()+"/api/v1/preauthkey", bytes.NewBuffer(jsonBody))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("headscale API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("Pre-auth key creation failed with status %d: %s", resp.StatusCode, string(body))
		return "", fmt.Errorf("headscale API returned status %d: %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response body: %w", err)
	}

	log.Printf("Pre-auth key API response: %s", string(body))

	var keyResp PreAuthKeyResponse
	if err := json.Unmarshal(body, &keyResp); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	if keyResp.PreAuthKey.Key == "" {
		return "", fmt.Errorf("received empty pre-auth key")
	}

	return keyResp.PreAuthKey.Key, nil
}

func getHeadscaleNodes() ([]HeadscaleNode, error) {
	apiKey, err := getAPIKey()
	if err != nil {
		return nil, err
	}

	client := &http.Client{}
	req, err := http.NewRequest("GET", getHeadscaleAPIURL()+"/api/v1/node", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("headscale API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("headscale API returned status %d: %s", resp.StatusCode, string(body))
	}

	var response struct {
		Nodes []HeadscaleNode `json:"nodes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Nodes, nil
}

func main() {
	allowedApps := os.Getenv("ALLOWED_APPS")

	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	config := Config{
		AllowedApps:      parseAllowedApps(allowedApps),
		AllowedNodeTypes: []string{"mongodb", "app"},
	}

	keyBytes := make([]byte, 32)
	rand.Read(keyBytes)
	keyfile := base64.StdEncoding.EncodeToString(keyBytes)

	headscaleURL := buildHeadscaleURL()
	log.Printf("Using Headscale URL: %s", headscaleURL)

	state := &AppState{
		config:       config,
		nodes:        make(map[string]NodeInfo),
		keyfile:      keyfile,
		headscaleURL: headscaleURL,
	}

	log.Printf("API server starting with allowed apps: %v", config.AllowedApps)

	r := gin.Default()

	r.Use(func(c *gin.Context) {
		if c.Request.URL.Path == "/health" || c.Request.URL.Path == "/api/nodes" {
			c.Next()
			return
		}

		appID := c.GetHeader("x-dstack-app-id")
		if appID == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			c.Abort()
			return
		}

		if !state.isAppAllowed(appID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Forbidden"})
			c.Abort()
			return
		}

		c.Next()
	})

	r.GET("/api/bootstrap", func(c *gin.Context) {
		instanceUUID := c.Query("instance_id")
		nodeType := c.Query("node_type")
		nodeName := c.Query("node_name")

		if instanceUUID == "" || nodeType == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Missing required parameters"})
			return
		}

		allowed := false
		for _, t := range state.config.AllowedNodeTypes {
			if t == nodeType {
				allowed = true
				break
			}
		}

		if !allowed {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid node type"})
			return
		}

		preAuthKey, err := generatePreAuthKey()
		if err != nil {
			log.Printf("Failed to generate pre-auth key: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate pre-auth key"})
			return
		}

		if nodeName == "" {
			nodeName = fmt.Sprintf("node-%s", instanceUUID)
		}

		nodeInfo := NodeInfo{
			UUID:        instanceUUID,
			Name:        nodeName,
			NodeType:    nodeType,
			TailscaleIP: nil,
		}

		state.mutex.Lock()
		state.nodes[instanceUUID] = nodeInfo
		state.mutex.Unlock()

		response := BootstrapResponse{
			PreAuthKey:   preAuthKey,
			Keyfile:      state.keyfile,
			HeadscaleURL: state.headscaleURL,
		}

		log.Printf("Bootstrap request from %s (%s)", nodeName, instanceUUID)
		c.JSON(http.StatusOK, response)
	})

	r.GET("/api/nodes", func(c *gin.Context) {
		nodeType := c.Query("node_type")

		headscaleNodes, err := getHeadscaleNodes()
		if err != nil {
			log.Printf("Failed to get headscale nodes: %v", err)
			state.mutex.RLock()
			var filteredNodes []NodeInfo
			for _, node := range state.nodes {
				if nodeType == "" || node.NodeType == nodeType {
					filteredNodes = append(filteredNodes, node)
				}
			}
			state.mutex.RUnlock()
			if filteredNodes == nil {
				filteredNodes = []NodeInfo{}
			}
			response := NodesResponse{Nodes: filteredNodes}
			c.JSON(http.StatusOK, response)
			return
		}

		state.mutex.RLock()
		var mergedNodes []NodeInfo
		for _, hsNode := range headscaleNodes {
			storedNode, exists := state.nodes[hsNode.Name] // Use name as lookup key
			if exists {
				mergedNode := NodeInfo{
					UUID:        storedNode.UUID,
					Name:        storedNode.Name,
					NodeType:    storedNode.NodeType,
					TailscaleIP: &hsNode.IPAddresses[0],
				}
				if nodeType == "" || mergedNode.NodeType == nodeType {
					mergedNodes = append(mergedNodes, mergedNode)
				}
			}
		}
		state.mutex.RUnlock()

		if mergedNodes == nil {
			mergedNodes = []NodeInfo{}
		}
		response := NodesResponse{Nodes: mergedNodes}
		c.JSON(http.StatusOK, response)
	})

	r.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "OK")
	})

	log.Printf("API server listening on port %s", port)
	r.Run(":" + port)
}
