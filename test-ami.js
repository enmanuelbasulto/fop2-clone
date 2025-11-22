const ami = require('asterisk-manager');

console.log('Testing AMI connection...');

const amiConnection = ami(5038, 'localhost', 'operator', 'mysecretpassword', true);

amiConnection.on('connect', () => {
    console.log('✅ SUCCESS: Connected to Asterisk AMI');
    
    // Test by getting system info
    amiConnection.action({
        'Action': 'CoreStatus'
    }, (err, res) => {
        if (err) {
            console.error('❌ Error getting core status:', err);
        } else {
            console.log('✅ Core status:', res);
        }
        process.exit(0);
    });
});

amiConnection.on('error', (err) => {
    console.error('❌ FAILED to connect to AMI:', err);
    console.log('\nTroubleshooting tips:');
    console.log('1. Check if manager.conf is configured correctly');
    console.log('2. Verify Asterisk is running: sudo asterisk -rvvv');
    console.log('3. Check if port 5038 is open: netstat -tulpn | grep 5038');
    console.log('4. Reload manager: sudo asterisk -rx "manager reload"');
    process.exit(1);
});

// Timeout after 5 seconds
setTimeout(() => {
    console.error('❌ Connection timeout');
    process.exit(1);
}, 5000);
