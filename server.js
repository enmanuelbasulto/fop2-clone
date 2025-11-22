const WebSocket = require('ws');
const ami = require('asterisk-manager');
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');

const app = express();
const HTTP_PORT = 3000;

// Enhanced logging setup
const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

const CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG; // Change to INFO for production

function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const levelStr = Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === level);
    
    if (level <= CURRENT_LOG_LEVEL) {
        const logMessage = `[${timestamp}] [${levelStr}] ${message}`;
        console.log(logMessage);
        if (data) {
            console.log('Data:', data);
        }
        
        // Write to log file
        const logEntry = logMessage + (data ? ` - ${JSON.stringify(data)}` : '') + '\n';
        fs.appendFileSync('/tmp/operator-panel.log', logEntry, 'utf8');
    }
}

// Get local IP address for LAN access
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                return interface.address;
            }
        }
    }
    return '0.0.0.0';
}

const LOCAL_IP = getLocalIP();
log(LOG_LEVELS.INFO, `Server starting`, { localIP: LOCAL_IP, port: HTTP_PORT });

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Request logging middleware
app.use((req, res, next) => {
    log(LOG_LEVELS.INFO, `HTTP ${req.method} ${req.url}`, { 
        ip: req.ip,
        userAgent: req.get('User-Agent')
    });
    next();
});

// Load users
let users = {};
try {
    users = JSON.parse(fs.readFileSync('./config/users.json', 'utf8')).users;
    log(LOG_LEVELS.INFO, 'Users loaded successfully', { userCount: Object.keys(users).length });
} catch (error) {
    log(LOG_LEVELS.ERROR, 'Failed to load users', { error: error.message });
    process.exit(1);
}

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session.authenticated) {
        next();
    } else {
        log(LOG_LEVELS.WARN, 'Unauthorized access attempt', { path: req.path, ip: req.ip });
        res.redirect('/');
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/panel', requireAuth, (req, res) => {
    log(LOG_LEVELS.INFO, 'Panel access', { user: req.session.extension });
    res.sendFile(path.join(__dirname, 'public', 'panel.html'));
});

app.post('/login', (req, res) => {
    const { extension, password } = req.body;
    log(LOG_LEVELS.INFO, 'Login attempt', { extension: extension });
    
    if (users[extension] && bcrypt.compareSync(password, users[extension].password)) {
        req.session.authenticated = true;
        req.session.extension = extension;
        req.session.username = users[extension].name;
        log(LOG_LEVELS.INFO, 'Login successful', { extension: extension });
        res.json({ success: true, message: 'Login successful' });
    } else {
        log(LOG_LEVELS.WARN, 'Login failed', { extension: extension });
        res.json({ success: false, message: 'Invalid extension or password' });
    }
});

app.post('/logout', (req, res) => {
    log(LOG_LEVELS.INFO, 'User logout', { user: req.session.extension });
    req.session.destroy();
    res.json({ success: true });
});

// Serve the WebSocket connection info to the client
app.get('/server-info', (req, res) => {
    res.json({
        wsHost: LOCAL_IP,
        wsPort: 8080
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        connections: connections.size,
        amiConnected: amiConnection && amiConnection.connected
    });
});

// Start HTTP server - bind to all interfaces
app.listen(HTTP_PORT, '0.0.0.0', () => {
    log(LOG_LEVELS.INFO, `HTTP server started`, {
        localUrl: `http://localhost:${HTTP_PORT}`,
        lanUrl: `http://${LOCAL_IP}:${HTTP_PORT}`
    });
});

// WebSocket Server for Real-time Communications - bind to all interfaces
const wss = new WebSocket.Server({ 
    port: 8080,
    host: '0.0.0.0'
}, () => {
    log(LOG_LEVELS.INFO, `WebSocket server started`, {
        localUrl: `ws://localhost:8080`,
        lanUrl: `ws://${LOCAL_IP}:8080`
    });
});

// Store active connections with user info
const connections = new Map();
const activeCalls = new Map();

// Enhanced AMI connection with retry logic
function connectToAMI() {
    log(LOG_LEVELS.INFO, 'Connecting to Asterisk AMI');
    
    const amiConnection = ami(5038, 'localhost', 'operator', 'mysecretpassword', true);

    amiConnection.on('connect', () => {
        log(LOG_LEVELS.INFO, '✅ Connected to Asterisk AMI successfully');
        
        // Subscribe to events we need
        amiConnection.action({
            'Action': 'Events',
            'EventMask': 'on'
        });
        
        // Get initial queue status
        amiConnection.action({
            'Action': 'QueueStatus',
            'Queue': ''
        });
        
        // Get initial extension status
        amiConnection.action({
            'Action': 'ExtensionStateList'
        });
        
        setupAMIEventHandlers(amiConnection);
    });

    amiConnection.on('error', (err) => {
        log(LOG_LEVELS.ERROR, '❌ AMI connection error', { error: err.message });
        log(LOG_LEVELS.INFO, 'Retrying AMI connection in 10 seconds...');
        setTimeout(connectToAMI, 10000);
    });

    amiConnection.on('close', () => {
        log(LOG_LEVELS.WARN, '🔌 AMI connection closed');
        log(LOG_LEVELS.INFO, 'Reconnecting AMI in 5 seconds...');
        setTimeout(connectToAMI, 5000);
    });

    return amiConnection;
}

function setupAMIEventHandlers(amiConnection) {
    // Extension status events
    amiConnection.on('extensionstatus', (event) => {
        log(LOG_LEVELS.DEBUG, 'Extension status update', event);
        broadcastToAll({
            type: 'extensionStatus',
            extension: event.exten,
            status: getStatusText(event.status)
        });
    });

    // Queue events
    amiConnection.on('queuemember', (event) => {
        log(LOG_LEVELS.DEBUG, 'Queue member update', event);
        broadcastToAll({
            type: 'queueMember',
            queue: event.queue,
            member: event.membername,
            status: event.status,
            paused: event.paused,
            callsTaken: event.callstaken
        });
    });

    amiConnection.on('queueentry', (event) => {
        log(LOG_LEVELS.DEBUG, 'Queue entry update', event);
        broadcastToAll({
            type: 'queueEntry',
            queue: event.queue,
            position: event.position,
            callerId: event.callerid,
            wait: event.wait
        });
    });

    amiConnection.on('queuestatus', (event) => {
        log(LOG_LEVELS.DEBUG, 'Queue status update', event);
        broadcastToAll({
            type: 'queueStatus',
            queue: event.queue,
            members: event.members,
            calls: event.calls,
            completed: event.completed
        });
    });

    // Call events
    amiConnection.on('newchannel', (event) => {
        log(LOG_LEVELS.DEBUG, 'New channel created', event);
        
        // Check if this is a call we originated
        if (event.channel.startsWith('Local/') && event.calleridnum) {
            const targetExtension = event.channel.split('/')[1].split('@')[0];
            const callerExtension = event.calleridnum;
            
            log(LOG_LEVELS.INFO, 'Call originated', { caller: callerExtension, target: targetExtension });
            broadcastToUser(callerExtension, {
                type: 'callProgress',
                extension: targetExtension,
                status: 'Ringing'
            });
        }
    });

    amiConnection.on('bridge', (event) => {
        if (event.bridgestate === 'Link') {
            log(LOG_LEVELS.INFO, 'Call connected', event);
            
            // Extract extensions from channel names
            const callerExt = extractExtensionFromChannel(event.channel1);
            const targetExt = extractExtensionFromChannel(event.channel2);
            
            if (callerExt && targetExt) {
                broadcastToUser(callerExt, {
                    type: 'callConnected',
                    extension: targetExt,
                    callerId: event.callerid1,
                    connectedLine: event.callerid2
                });
            }
        }
    });

    amiConnection.on('hangup', (event) => {
        log(LOG_LEVELS.INFO, 'Call ended', event);
        
        // Extract extension from channel and notify
        const extension = extractExtensionFromChannel(event.channel);
        if (extension) {
            broadcastToUser(extension, {
                type: 'callEnded',
                channel: event.channel,
                reason: event.cause || 'Normal hangup'
            });
        }
    });

    // Other events for debugging
    amiConnection.on('userevent', (event) => {
        log(LOG_LEVELS.DEBUG, 'User event received', event);
    });
}

// Initialize AMI connection
const amiConnection = connectToAMI();

// Helper function to convert status codes to text
function getStatusText(statusCode) {
    const statusMap = {
        '0': 'idle',
        '1': 'inuse',
        '2': 'busy',
        '4': 'ringing',
        '8': 'ringing',
        '16': 'unavailable'
    };
    return statusMap[statusCode] || 'unknown';
}

// Helper function to extract extension from channel name
function extractExtensionFromChannel(channel) {
    const match = channel.match(/Local\/(\d+)@/);
    return match ? match[1] : null;
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    const clientIP = req.connection.remoteAddress;
    log(LOG_LEVELS.INFO, 'New WebSocket client connected', { ip: clientIP });
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            log(LOG_LEVELS.DEBUG, 'WebSocket message received', { message: message });
            
            // Handle authentication first
            if (message.action === 'authenticate') {
                const { extension, password } = message;
                
                if (users[extension] && bcrypt.compareSync(password, users[extension].password)) {
                    connections.set(ws, { 
                        extension, 
                        name: users[extension].name,
                        ip: clientIP
                    });
                    ws.send(JSON.stringify({ 
                        type: 'auth_success', 
                        user: { extension, name: users[extension].name } 
                    }));
                    log(LOG_LEVELS.INFO, 'User authenticated via WebSocket', { 
                        extension: extension, 
                        ip: clientIP 
                    });
                } else {
                    ws.send(JSON.stringify({ type: 'auth_failed', message: 'Invalid credentials' }));
                    log(LOG_LEVELS.WARN, 'WebSocket authentication failed', { 
                        extension: extension, 
                        ip: clientIP 
                    });
                    ws.close();
                }
                return;
            }
            
            // Check if user is authenticated for other actions
            const userInfo = connections.get(ws);
            if (!userInfo) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
                log(LOG_LEVELS.WARN, 'Unauthorized WebSocket action attempt', { 
                    ip: clientIP,
                    action: message.action 
                });
                return;
            }
            
            // Process authenticated actions
            handleClientMessage(ws, message, userInfo);
            
        } catch (error) {
            log(LOG_LEVELS.ERROR, 'Error processing WebSocket message', { 
                error: error.message,
                data: data.toString() 
            });
        }
    });

    ws.on('close', (code, reason) => {
        const userInfo = connections.get(ws);
        if (userInfo) {
            log(LOG_LEVELS.INFO, 'WebSocket client disconnected', { 
                extension: userInfo.extension, 
                ip: userInfo.ip,
                code: code,
                reason: reason.toString()
            });
            connections.delete(ws);
        } else {
            log(LOG_LEVELS.INFO, 'Unauthenticated WebSocket client disconnected', { 
                ip: clientIP,
                code: code,
                reason: reason.toString()
            });
        }
    });

    ws.on('error', (error) => {
        log(LOG_LEVELS.ERROR, 'WebSocket error', { 
            error: error.message,
            ip: clientIP 
        });
    });
});

function handleClientMessage(ws, message, userInfo) {
    log(LOG_LEVELS.INFO, 'Processing client action', { 
        user: userInfo.extension, 
        action: message.action,
        data: message 
    });
    
    switch (message.action) {
        case 'dial':
            handleDial(message.extension, userInfo.extension);
            break;
        case 'hangup':
            handleHangup(message.channel, userInfo.extension);
            break;
        case 'transfer':
            handleTransfer(message.channel, message.target, userInfo.extension);
            break;
        case 'spy':
            handleSpy(message.channel, userInfo.extension);
            break;
        case 'whisper':
            handleWhisper(message.channel, userInfo.extension);
            break;
        case 'pause':
            handleQueuePause(userInfo.extension, message.queue, message.pause);
            break;
        // Add to your handleClientMessage function in server.js
        case 'answer':
            handleAnswerCall(message.channel, message.extension, userInfo.extension);
            break;
        default:
            log(LOG_LEVELS.WARN, 'Unknown action received', { 
                action: message.action,
                user: userInfo.extension 
            });
            ws.send(JSON.stringify({ 
                type: 'error', 
                message: `Unknown action: ${message.action}` 
            }));
    }
}

// Enhanced Call Control Functions with better logging
// Add answer call handler
function handleAnswerCall(channel, extension, userExtension) {
    log(LOG_LEVELS.INFO, 'Answer call request', { 
        user: userExtension, 
        channel: channel, 
        extension: extension 
    });
    
    // Answer the channel (for SIP channels)
    amiConnection.action({
        'Action': 'Redirect',
        'Channel': channel,
        'Context': 'from-internal',
        'Exten': extension,
        'Priority': 1
    }, (err, res) => {
        if (err) {
            log(LOG_LEVELS.ERROR, 'Answer call failed', { 
                user: userExtension, 
                channel: channel,
                error: err.message 
            });
        } else {
            log(LOG_LEVELS.INFO, 'Call answered successfully', { 
                user: userExtension, 
                channel: channel,
                response: res 
            });
        }
    });
}

function handleDial(targetExtension, callerExtension) {
    log(LOG_LEVELS.INFO, 'Dial request', { caller: callerExtension, target: targetExtension });
    
    // Validate extension format
    if (!/^\d+$/.test(targetExtension)) {
        const errorMsg = 'Invalid extension format - numbers only';
        log(LOG_LEVELS.WARN, 'Dial validation failed', { 
            caller: callerExtension, 
            target: targetExtension,
            error: errorMsg 
        });
        broadcastToUser(callerExtension, {
            type: 'dialFailed',
            extension: targetExtension,
            reason: errorMsg
        });
        return;
    }
    
    const channel = `Local/${targetExtension}@from-internal`;
    const callerID = `Operator ${callerExtension} <${callerExtension}>`;
    
    // Notify user that call is being initiated
    broadcastToUser(callerExtension, {
        type: 'callProgress',
        extension: targetExtension,
        status: 'Dialing...'
    });
    
    amiConnection.action({
        'Action': 'Originate',
        'Channel': channel,
        'Context': 'from-internal',
        'Exten': 's',
        'Priority': 1,
        'CallerID': callerID,
        'Timeout': 30000,
        'Async': 'yes'
    }, (err, res) => {
        if (err) {
            log(LOG_LEVELS.ERROR, 'Dial action failed', { 
                caller: callerExtension, 
                target: targetExtension,
                error: err.message 
            });
            broadcastToUser(callerExtension, {
                type: 'dialFailed',
                extension: targetExtension,
                reason: err.message || 'Unknown error'
            });
        } else {
            log(LOG_LEVELS.INFO, 'Dial action successful', { 
                caller: callerExtension, 
                target: targetExtension,
                response: res 
            });
            // Store call information for tracking
            const callId = `${callerExtension}-${targetExtension}-${Date.now()}`;
            activeCalls.set(callId, {
                caller: callerExtension,
                target: targetExtension,
                channel: res.Channel || channel,
                startTime: new Date()
            });
            log(LOG_LEVELS.DEBUG, 'Active call stored', { callId: callId });
        }
    });
}

function handleHangup(channel, userExtension) {
    log(LOG_LEVELS.INFO, 'Hangup request', { user: userExtension, channel: channel });
    
    amiConnection.action({
        'Action': 'Hangup',
        'Channel': channel
    }, (err, res) => {
        if (err) {
            log(LOG_LEVELS.ERROR, 'Hangup failed', { 
                user: userExtension, 
                channel: channel,
                error: err.message 
            });
        } else {
            log(LOG_LEVELS.INFO, 'Hangup successful', { 
                user: userExtension, 
                channel: channel,
                response: res 
            });
        }
    });
}

function handleTransfer(channel, target, userExtension) {
    log(LOG_LEVELS.INFO, 'Transfer request', { 
        user: userExtension, 
        channel: channel, 
        target: target 
    });
    
    amiConnection.action({
        'Action': 'Redirect',
        'Channel': channel,
        'Context': 'from-internal',
        'Exten': target,
        'Priority': 1
    }, (err, res) => {
        if (err) {
            log(LOG_LEVELS.ERROR, 'Transfer failed', { 
                user: userExtension, 
                channel: channel,
                target: target,
                error: err.message 
            });
        } else {
            log(LOG_LEVELS.INFO, 'Transfer successful', { 
                user: userExtension, 
                channel: channel,
                target: target,
                response: res 
            });
        }
    });
}

function handleSpy(channel, spyExtension) {
    log(LOG_LEVELS.INFO, 'Spy request', { user: spyExtension, channel: channel });
    
    amiConnection.action({
        'Action': 'Originate',
        'Channel': `Local/${spyExtension}@from-internal`,
        'Context': 'from-internal',
        'Exten': 'spy',
        'Priority': 1,
        'CallerID': `Spy <${spyExtension}>`,
        'Variable': `SPY_CHANNEL=${channel}`
    }, (err, res) => {
        if (err) {
            log(LOG_LEVELS.ERROR, 'Spy failed', { 
                user: spyExtension, 
                channel: channel,
                error: err.message 
            });
        } else {
            log(LOG_LEVELS.INFO, 'Spy successful', { 
                user: spyExtension, 
                channel: channel,
                response: res 
            });
        }
    });
}

function handleWhisper(channel, whisperExtension) {
    log(LOG_LEVELS.INFO, 'Whisper request', { user: whisperExtension, channel: channel });
    
    amiConnection.action({
        'Action': 'Originate',
        'Channel': `Local/${whisperExtension}@from-internal`,
        'Context': 'from-internal',
        'Exten': 'whisper',
        'Priority': 1,
        'CallerID': `Coach <${whisperExtension}>`,
        'Variable': `SPY_CHANNEL=${channel}`
    }, (err, res) => {
        if (err) {
            log(LOG_LEVELS.ERROR, 'Whisper failed', { 
                user: whisperExtension, 
                channel: channel,
                error: err.message 
            });
        } else {
            log(LOG_LEVELS.INFO, 'Whisper successful', { 
                user: whisperExtension, 
                channel: channel,
                response: res 
            });
        }
    });
}

function handleQueuePause(agent, queue, pause = true) {
    log(LOG_LEVELS.INFO, 'Queue pause request', { 
        agent: agent, 
        queue: queue, 
        pause: pause 
    });
    
    amiConnection.action({
        'Action': 'QueuePause',
        'Interface': `Local/${agent}@from-internal`,
        'Queue': queue,
        'Paused': pause ? '1' : '0'
    }, (err, res) => {
        if (err) {
            log(LOG_LEVELS.ERROR, 'Queue pause failed', { 
                agent: agent, 
                queue: queue,
                pause: pause,
                error: err.message 
            });
        } else {
            log(LOG_LEVELS.INFO, 'Queue pause successful', { 
                agent: agent, 
                queue: queue,
                pause: pause,
                response: res 
            });
        }
    });
}

// Broadcast functions
function broadcastToAll(message) {
    log(LOG_LEVELS.DEBUG, 'Broadcasting to all clients', { 
        messageType: message.type, 
        clientCount: connections.size 
    });
    
    connections.forEach((userInfo, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

function broadcastToUser(extension, message) {
    log(LOG_LEVELS.DEBUG, 'Broadcasting to user', { 
        extension: extension, 
        messageType: message.type 
    });
    
    connections.forEach((userInfo, ws) => {
        if (userInfo.extension === extension && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

// Add to your AMI event handlers section in server.js

// Handle incoming calls
amiConnection.on('newstate', (event) => {
    log(LOG_LEVELS.DEBUG, 'Channel state change', event);
    
    // Detect inbound calls (ringing state)
    if (event.channelstate === '4' || event.channelstate === '5') {
        // This is a ringing channel (incoming call)
        const extension = extractExtensionFromChannel(event.channel);
        if (extension) {
            log(LOG_LEVELS.INFO, 'Incoming call detected', {
                extension: extension,
                channel: event.channel,
                callerId: event.calleridnum
            });
            
            broadcastToAll({
                type: 'incomingCall',
                extension: extension,
                channel: event.channel,
                callerId: event.calleridnum || 'Unknown',
                callerIdName: event.calleridname || 'Unknown'
            });
        }
    }
});

// Handle answered calls
amiConnection.on('bridgestate', (event) => {
    if (event.bridgestate === 'Link') {
        log(LOG_LEVELS.INFO, 'Call answered/bridged', event);
        
        // Extract both parties from the bridge
        const callerExt = extractExtensionFromChannel(event.channel1);
        const calleeExt = extractExtensionFromChannel(event.channel2);
        
        if (callerExt && calleeExt) {
            broadcastToAll({
                type: 'callAnswered',
                callerExtension: callerExt,
                calleeExtension: calleeExt,
                channel1: event.channel1,
                channel2: event.channel2
            });
        }
    }
});

// Enhanced hangup handler to detect call completion
amiConnection.on('hangup', (event) => {
    log(LOG_LEVELS.INFO, 'Call completed', event);
    
    const extension = extractExtensionFromChannel(event.channel);
    if (extension) {
        broadcastToAll({
            type: 'callCompleted',
            extension: extension,
            channel: event.channel,
            duration: event.duration || '0',
            reason: event.cause_txt || 'Normal hangup'
        });
    }
});

// Improved extension extraction to handle more channel types
function extractExtensionFromChannel(channel) {
    // Handle Local/channel formats
    let match = channel.match(/Local\/(\d+)@/);
    if (match) return match[1];
    
    // Handle PJSIP/channel formats
    match = channel.match(/PJSIP\/(\d+)/);
    if (match) return match[1];
    
    // Handle SIP/channel formats
    match = channel.match(/SIP\/(\d+)/);
    if (match) return match[1];
    
    // Handle DAHDI channels (if using analog/digital cards)
    match = channel.match(/DAHDI\/(\d+)/);
    if (match) return match[1];
    
    log(LOG_LEVELS.DEBUG, 'Could not extract extension from channel', { channel: channel });
    return null;
}

// Graceful shutdown handling
process.on('SIGINT', () => {
    log(LOG_LEVELS.INFO, 'Received SIGINT, shutting down gracefully');
    shutdown();
});

process.on('SIGTERM', () => {
    log(LOG_LEVELS.INFO, 'Received SIGTERM, shutting down gracefully');
    shutdown();
});

function shutdown() {
    log(LOG_LEVELS.INFO, 'Starting shutdown process');
    
    // Close WebSocket connections
    connections.forEach((userInfo, ws) => {
        ws.close(1001, 'Server shutting down');
    });
    
    // Close WebSocket server
    wss.close(() => {
        log(LOG_LEVELS.INFO, 'WebSocket server closed');
    });
    
    // Close HTTP server
    app.close(() => {
        log(LOG_LEVELS.INFO, 'HTTP server closed');
        process.exit(0);
    });
    
    // Force exit after 10 seconds
    setTimeout(() => {
        log(LOG_LEVELS.WARN, 'Forcing shutdown after timeout');
        process.exit(1);
    }, 10000);
}

log(LOG_LEVELS.INFO, 'Server initialization complete');
