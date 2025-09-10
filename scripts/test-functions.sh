#!/bin/bash
# test_healthcheck.sh
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source $SCRIPT_DIR/functions.sh

TEST_SCRIPT="/tmp/test-dstack-healthcheck.sh"
HEALTHCHECK_SCRIPT=$TEST_SCRIPT

TEST_COUNT=0
PASS_COUNT=0

# Test helper functions
assert_equals() {
    local expected="$1"
    local actual="$2"
    local test_name="$3"
    
    TEST_COUNT=$((TEST_COUNT + 1))
    
    if [ "$expected" = "$actual" ]; then
        echo "✅ PASS: $test_name"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "❌ FAIL: $test_name"
        echo "   Expected: '$expected'"
        echo "   Actual:   '$actual'"
    fi
}

assert_file_contains() {
    local file="$1"
    local pattern="$2"
    local test_name="$3"
    
    TEST_COUNT=$((TEST_COUNT + 1))
    
    if [ -f "$file" ] && grep -q "$pattern" "$file"; then
        echo "✅ PASS: $test_name"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "❌ FAIL: $test_name"
        echo "   File: $file"
        echo "   Pattern: $pattern"
        if [ -f "$file" ]; then
            echo "   File contents:"
            cat "$file" | sed 's/^/     /'
        else
            echo "   File does not exist"
        fi
    fi
}

assert_file_exists() {
    local file="$1"
    local test_name="$2"
    
    TEST_COUNT=$((TEST_COUNT + 1))
    
    if [ -f "$file" ]; then
        echo "✅ PASS: $test_name"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "❌ FAIL: $test_name - File $file does not exist"
    fi
}

assert_file_executable() {
    local file="$1"
    local test_name="$2"
    
    TEST_COUNT=$((TEST_COUNT + 1))
    
    if [ -x "$file" ]; then
        echo "✅ PASS: $test_name"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "❌ FAIL: $test_name - File $file is not executable"
    fi
}

# Test cases
test_container_healthcheck() {
    echo "🧪 Testing container healthcheck..."
    rm -f "$TEST_SCRIPT"
    
    healthcheck container myapp
    
    assert_file_exists "$TEST_SCRIPT" "Container healthcheck creates script file"
    assert_file_executable "$TEST_SCRIPT" "Container healthcheck script is executable"
    assert_file_contains "$TEST_SCRIPT" "docker inspect.*myapp.*grep -q healthy" "Container healthcheck has correct command"
}

test_url_healthcheck() {
    echo "🧪 Testing URL healthcheck..."
    rm -f "$TEST_SCRIPT"
    
    healthcheck url "http://localhost:8080/health"
    
    assert_file_exists "$TEST_SCRIPT" "URL healthcheck creates script file"
    assert_file_contains "$TEST_SCRIPT" "wget.*http://localhost:8080/health" "URL healthcheck has correct command"
}

test_cmd_healthcheck() {
    echo "🧪 Testing command healthcheck..."
    rm -f "$TEST_SCRIPT"
    
    healthcheck cmd "ps aux | grep nginx"
    
    assert_file_exists "$TEST_SCRIPT" "Command healthcheck creates script file"
    assert_file_contains "$TEST_SCRIPT" "ps aux | grep nginx" "Command healthcheck has correct command"
}

test_append_functionality() {
    echo "🧪 Testing append functionality..."
    rm -f "$TEST_SCRIPT"
    
    # Create initial healthcheck
    healthcheck container app1
    
    # Append another check
    healthcheck -a url "http://localhost:8080"
    
    assert_file_contains "$TEST_SCRIPT" "docker inspect.*app1" "Append preserves original command"
    assert_file_contains "$TEST_SCRIPT" "wget.*localhost:8080" "Append adds new command"
    
    # Count number of 'exit 1' statements (should be 2)
    local exit_count=$(grep -c "exit 1" "$TEST_SCRIPT" 2>/dev/null || echo 0)
    assert_equals "2" "$exit_count" "Append creates two separate commands"
}

test_invalid_usage() {
    echo "🧪 Testing invalid usage..."
    rm -f "$TEST_SCRIPT"
    
    # Test invalid kind - capture exit code correctly
    healthcheck invalid_kind >/dev/null 2>&1
    local exit_code=$?
    
    assert_equals "1" "$exit_code" "Invalid kind returns exit code 1"
    
    # Test no arguments
    healthcheck 2>&1
    exit_code=$?
    
    assert_equals "1" "$exit_code" "No arguments returns exit code 1"
}

test_complex_command() {
    echo "🧪 Testing complex command..."
    rm -f "$TEST_SCRIPT"
    
    healthcheck cmd systemctl is-active nginx '&&' curl -f localhost
    
    assert_file_contains "$TEST_SCRIPT" "systemctl is-active nginx && curl -f localhost" "Complex command preserved correctly"
}

test_multiple_appends() {
    echo "🧪 Testing multiple appends..."
    rm -f "$TEST_SCRIPT"
    
    healthcheck container app1
    healthcheck -a url "http://localhost:8080"
    healthcheck -a cmd "ps aux | grep nginx"
    healthcheck -a container app2
    
    assert_file_contains "$TEST_SCRIPT" "docker inspect.*app1" "First container check exists"
    assert_file_contains "$TEST_SCRIPT" "wget.*localhost:8080" "URL check exists"
    assert_file_contains "$TEST_SCRIPT" "ps aux | grep nginx" "Command check exists"
    assert_file_contains "$TEST_SCRIPT" "docker inspect.*app2" "Second container check exists"
    
    local exit_count=$(grep -c "exit 1" "$TEST_SCRIPT" 2>/dev/null || echo 0)
    assert_equals "4" "$exit_count" "Multiple appends create four separate commands"
}

test_script_execution() {
    echo "🧪 Testing script execution..."
    rm -f "$TEST_SCRIPT"
    
    # Create a healthcheck that should pass
    healthcheck cmd "echo 'test' > /dev/null"
    
    # Execute the script
    if "$TEST_SCRIPT" >/dev/null 2>&1; then
        echo "✅ PASS: Generated script executes successfully"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "❌ FAIL: Generated script execution failed"
    fi
    TEST_COUNT=$((TEST_COUNT + 1))
    
    # Create a healthcheck that should fail
    healthcheck cmd "exit 1"
    
    # Execute the script (should fail)
    if ! "$TEST_SCRIPT" >/dev/null 2>&1; then
        echo "✅ PASS: Generated script fails as expected"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "❌ FAIL: Generated script should have failed but passed"
    fi
    TEST_COUNT=$((TEST_COUNT + 1))
}

# Run all tests
run_tests() {
    echo "🚀 Starting healthcheck function tests..."
    echo "========================================"
    
    test_container_healthcheck
    test_url_healthcheck
    test_cmd_healthcheck
    test_append_functionality
    test_invalid_usage
    test_complex_command
    test_multiple_appends
    test_script_execution
    
    echo "========================================"
    echo "📊 Test Results: $PASS_COUNT/$TEST_COUNT tests passed"
    
    if [ "$PASS_COUNT" -eq "$TEST_COUNT" ]; then
        echo "🎉 All tests passed!"
        exit 0
    else
        echo "💥 Some tests failed!"
        exit 1
    fi
}

# Run the tests
run_tests