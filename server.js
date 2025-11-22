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
console.log(`Local IP address: ${LOCAL_IP}`);
console.log(`Server will be accessible at: http://${LOCAL_IP}:${HTTP_PORT}`);

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

// Load users
const users = JSON.parse(fs.readFileSync('./config/users.json', 'utf8')).users;

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/');
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/panel', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'panel.html'));
});

app.post('/login', (req, res) => {
  const { extension, password } = req.body;
  
  if (users[extension] && bcrypt.compareSync(password, users[extension].password)) {
    req.session.authenticated = true;
    req.session.extension = extension;
    req.session.username = users[extension].name;
    res.json({ success: true, message: 'Login successful' });
  } else {
    res.json({ success: false, message: 'Invalid extension or password' });
  }
});

app.post('/logout', (req, res) => {
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

// Start HTTP server - bind to all interfaces
app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`HTTP server running on all interfaces (http://localhost:${HTTP_PORT})`);
  console.log(`Access via LAN: http://${LOCAL_IP}:${HTTP_PORT}`);
});

// WebSocket Server for Real-time Communications - bind to all interfaces
const wss = new WebSocket.Server({ 
  port: 8080,
  host: '0.0.0.0'
}, () => {
  console.log(`WebSocket server running on all interfaces (ws://localhost:8080)`);
  console.log(`Access via LAN: ws://${LOCAL_IP}:8080`);
});

// Store active connections with user info
const connections = new Map();

// Connect to Asterisk AMI
// Use 'localhost' for AMI if Asterisk is on the same machine
// Use the actual IP if Asterisk is on a different machine
// In server.js, update the AMI connection section:

// Connect to Asterisk AMI with correct credentials
const amiConnection = ami(5038, 'localhost', 'operator', 'mysecretpassword', true);

amiConnection.on('connect', () => {
    console.log('✅ Connected to Asterisk AMI successfully');
    
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
});

amiConnection.on('error', (err) => {
    console.error('❌ AMI connection error:', err);
});

amiConnection.on('close', () => {
    console.log('🔌 AMI connection closed');
});

// Enhanced event handlers for better debugging
amiConnection.on('userevent', (event) => {
    console.log('UserEvent:', event);
});

amiConnection.on('extensionstatus', (event) => {
    console.log('ExtensionStatus:', event);
    broadcastToAll({
        type: 'extensionStatus',
        extension: event.exten,
        status: getStatusText(event.status)
    });
});

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
// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const clientIP = req.connection.remoteAddress;
  console.log(`New WebSocket client connected from: ${clientIP}`);
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
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
          console.log(`User ${extension} authenticated via WebSocket from ${clientIP}`);
        } else {
          ws.send(JSON.stringify({ type: 'auth_failed', message: 'Invalid credentials' }));
          ws.close();
        }
        return;
      }
      
      // Check if user is authenticated for other actions
      const userInfo = connections.get(ws);
      if (!userInfo) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }
      
      // Process authenticated actions
      handleClientMessage(ws, message, userInfo);
      
    } catch (error) {
      console.error('Error processing client message:', error);
    }
  });

  ws.on('close', () => {
    const userInfo = connections.get(ws);
    if (userInfo) {
      console.log(`WebSocket client disconnected: ${userInfo.extension} (${userInfo.ip})`);
      connections.delete(ws);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// ... rest of the functions (handleClientMessage, handleDial, etc.) remain the same ...
function handleClientMessage(ws, message, userInfo) {
  switch (message.action) {
    case 'dial':
      handleDial(message.extension, userInfo.extension);
      break;
    case 'hangup':
      handleHangup(message.channel);
      break;
    case 'transfer':
      handleTransfer(message.channel, message.target, message.context);
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
  }
}

// Call Control Functions
function handleDial(targetExtension, callerExtension) {
  amiConnection.action({
    'Action': 'Originate',
    'Channel': `Local/${targetExtension}@from-internal`,
    'Context': 'from-internal',
    'Exten': 's',
    'Priority': 1,
    'CallerID': `Operator ${callerExtension} <${callerExtension}>`,
    'Timeout': 30000
  }, (err, res) => {
    if (err) console.error('Dial failed:', err);
  });
}

function handleHangup(channel) {
  amiConnection.action({
    'Action': 'Hangup',
    'Channel': channel
  }, (err, res) => {
    if (err) console.error('Hangup failed:', err);
  });
}

function handleTransfer(channel, target, context = 'from-internal') {
  amiConnection.action({
    'Action': 'Redirect',
    'Channel': channel,
    'Context': context,
    'Exten': target,
    'Priority': 1
  }, (err, res) => {
    if (err) console.error('Transfer failed:', err);
  });
}

function handleSpy(channel, spyExtension) {
  // ChanSpy application to listen to a channel
  amiConnection.action({
    'Action': 'Originate',
    'Channel': `Local/${spyExtension}@from-internal`,
    'Context': 'from-internal',
    'Exten': 'spy',
    'Priority': 1,
    'CallerID': `Spy <${spyExtension}>`,
    'Variable': `SPY_CHANNEL=${channel}`
  }, (err, res) => {
    if (err) console.error('Spy failed:', err);
  });
}

function handleWhisper(channel, whisperExtension) {
  // ChanSpy with whisper option (w)
  amiConnection.action({
    'Action': 'Originate',
    'Channel': `Local/${whisperExtension}@from-internal`,
    'Context': 'from-internal',
    'Exten': 'whisper',
    'Priority': 1,
    'CallerID': `Coach <${whisperExtension}>`,
    'Variable': `SPY_CHANNEL=${channel}`
  }, (err, res) => {
    if (err) console.error('Whisper failed:', err);
  });
}

function handleQueuePause(agent, queue, pause = true) {
  amiConnection.action({
    'Action': 'QueuePause',
    'Interface': `Local/${agent}@from-internal`,
    'Queue': queue,
    'Paused': pause ? '1' : '0'
  }, (err, res) => {
    if (err) console.error('Queue pause failed:', err);
  });
}

// Asterisk Event Handlers for Real-time Updates
amiConnection.on('extensionstatus', (event) => {
  broadcastToAll({
    type: 'extensionStatus',
    extension: event.exten,
    status: event.status
  });
});

amiConnection.on('queuemember', (event) => {
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
  broadcastToAll({
    type: 'queueEntry',
    queue: event.queue,
    position: event.position,
    callerId: event.callerid,
    wait: event.wait
  });
});

amiConnection.on('queuestatus', (event) => {
  broadcastToAll({
    type: 'queueStatus',
    queue: event.queue,
    members: event.members,
    calls: event.calls,
    completed: event.completed
  });
});

amiConnection.on('bridge', (event) => {
  if (event.bridgestate === 'Link') {
    broadcastToAll({
      type: 'callStart',
      channel1: event.channel1,
      channel2: event.channel2,
      callerId1: event.callerid1,
      callerId2: event.callerid2
    });
  }
});

function broadcastToAll(message) {
  connections.forEach((userInfo, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });
}

// Enhanced call handling functions
function handleDial(targetExtension, callerExtension) {
    console.log(`Dialing ${targetExtension} from ${callerExtension}`);
    
    // Validate extension format
    if (!/^\d+$/.test(targetExtension)) {
        broadcastToUser(callerExtension, {
            type: 'dialFailed',
            extension: targetExtension,
            reason: 'Invalid extension format'
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
            console.error('Dial failed:', err);
            broadcastToUser(callerExtension, {
                type: 'dialFailed',
                extension: targetExtension,
                reason: err.message || 'Unknown error'
            });
        } else {
            console.log('Dial successful:', res);
            // Store call information for tracking
            const callId = `${callerExtension}-${targetExtension}-${Date.now()}`;
            activeCalls.set(callId, {
                caller: callerExtension,
                target: targetExtension,
                channel: res.Channel || channel,
                startTime: new Date()
            });
        }
    });
}

// Enhanced: Monitor call events for better feedback
amiConnection.on('newchannel', (event) => {
    console.log('New channel:', event);
    
    // Check if this is a call we originated
    if (event.channel.startsWith('Local/') && event.calleridnum) {
        const targetExtension = event.channel.split('/')[1].split('@')[0];
        const callerExtension = event.calleridnum;
        
        broadcastToUser(callerExtension, {
            type: 'callProgress',
            extension: targetExtension,
            status: 'Ringing'
        });
    }
});

amiConnection.on('bridge', (event) => {
    if (event.bridgestate === 'Link') {
        console.log('Call connected:', event);
        
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
    console.log('Call ended:', event);
    
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

// Helper function to extract extension from channel name
function extractExtensionFromChannel(channel) {
    const match = channel.match(/Local\/(\d+)@/);
    return match ? match[1] : null;
}

// Helper function to broadcast to specific user
function broadcastToUser(extension, message) {
    connections.forEach((userInfo, ws) => {
        if (userInfo.extension === extension && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

// Track active calls
const activeCalls = new Map();

// Enhanced transfer function
function handleTransfer(channel, target, context = 'from-internal') {
    console.log(`Transferring ${channel} to ${target}`);
    
    amiConnection.action({
        'Action': 'Redirect',
        'Channel': channel,
        'Context': context,
        'Exten': target,
        'Priority': 1
    }, (err, res) => {
        if (err) {
            console.error('Transfer failed:', err);
        } else {
            console.log('Transfer successful:', res);
        }
    });
}
