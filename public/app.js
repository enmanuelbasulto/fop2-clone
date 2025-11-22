let ws = null;
let currentUser = null;
let activeCalls = new Map();
let extensions = new Map();
let queues = new Map();
let serverInfo = null;
let currentActiveCall = null;

// Login functionality
if (window.location.pathname === '/' || window.location.pathname === '/index.html') {
    document.getElementById('loginForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const extension = document.getElementById('extension').value;
        const password = document.getElementById('password').value;
        
        fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ extension, password })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                window.location.href = '/panel';
            } else {
                document.getElementById('message').textContent = data.message;
                document.getElementById('message').style.color = 'red';
            }
        });
    });
}

// Panel functionality
if (window.location.pathname === '/panel' || window.location.pathname === '/panel.html') {
    document.addEventListener('DOMContentLoaded', function() {
        // First get server info, then connect WebSocket
        fetch('/server-info')
            .then(response => response.json())
            .then(info => {
                serverInfo = info;
                console.log('Server info:', serverInfo);
                connectWebSocket();
            })
            .catch(error => {
                console.error('Failed to get server info:', error);
                // Fallback to same host
                serverInfo = { wsHost: window.location.hostname, wsPort: 8080 };
                connectWebSocket();
            });
        
        // Initialize enhanced call features
        initializeCallFeatures();
    });
}

function connectWebSocket() {
    if (!serverInfo) {
        console.error('No server info available');
        return;
    }
    
    const wsUrl = `ws://${serverInfo.wsHost}:${serverInfo.wsPort}`;
    console.log(`Connecting to WebSocket: ${wsUrl}`);
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket connected successfully');
        updateConnectionStatus('connected');
        
        // Get credentials from session or prompt
        if (currentUser) {
            // Re-authenticate if we have user info
            ws.send(JSON.stringify({
                action: 'authenticate',
                extension: currentUser.extension,
                password: '***' // You'll need to handle this differently
            }));
        } else {
            // For initial connection, we'll authenticate after login
            // The actual auth happens after user enters credentials
            const extension = prompt('Enter your extension:');
            const password = prompt('Enter your password:');
            
            if (extension && password) {
                ws.send(JSON.stringify({
                    action: 'authenticate',
                    extension: extension,
                    password: password
                }));
            }
        }
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Received:', data);
        
        switch (data.type) {
            case 'auth_success':
                currentUser = data.user;
                document.getElementById('userDisplay').textContent = 
                    `Welcome, ${data.user.name} (${data.user.extension})`;
                updateConnectionStatus('authenticated');
                break;
            case 'auth_failed':
                alert('Authentication failed: ' + data.message);
                updateConnectionStatus('auth_failed');
                break;
            case 'extensionStatus':
                updateExtension(data.extension, data.status);
                break;
            case 'queueMember':
                updateQueueMember(data);
                break;
            case 'queueEntry':
                updateQueueEntry(data);
                break;
            case 'queueStatus':
                updateQueueStatus(data);
                break;
            case 'callStart':
                addActiveCall(data);
                break;
            case 'callProgress':
                showNotification(`Call to ${data.extension}: ${data.status}`, 'info');
                break;
            case 'callConnected':
                showNotification(`Call connected to ${data.extension}`, 'success');
                updateActiveCallStatus({
                    callerId: data.callerId,
                    connectedLine: data.connectedLine,
                    extension: data.extension
                });
                break;
            case 'callEnded':
                showNotification(`Call ended with ${data.extension}`, 'info');
                updateActiveCallStatus(null);
                break;
            case 'dialFailed':
                showNotification(`Failed to dial ${data.extension}: ${data.reason}`, 'error');
                break;
            case 'error':
                console.error('Server error:', data.message);
                showNotification(data.message, 'error');
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
    };
    
    ws.onclose = (event) => {
        console.log('WebSocket disconnected:', event.code, event.reason);
        updateConnectionStatus('disconnected');
        
        // Try to reconnect after 5 seconds
        setTimeout(() => {
            console.log('Attempting to reconnect...');
            connectWebSocket();
        }, 5000);
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateConnectionStatus('error');
    };
}

function updateConnectionStatus(status) {
    const statusElement = document.getElementById('connectionStatus') || createStatusElement();
    
    const statusMessages = {
        'connected': 'Connected to server',
        'authenticated': 'Authenticated and ready',
        'disconnected': 'Disconnected from server',
        'auth_failed': 'Authentication failed',
        'error': 'Connection error'
    };
    
    const statusColors = {
        'connected': '#28a745',
        'authenticated': '#17a2b8', 
        'disconnected': '#dc3545',
        'auth_failed': '#ffc107',
        'error': '#dc3545'
    };
    
    statusElement.textContent = statusMessages[status] || status;
    statusElement.style.color = statusColors[status] || '#6c757d';
}

function createStatusElement() {
    const statusElement = document.createElement('div');
    statusElement.id = 'connectionStatus';
    statusElement.style.marginLeft = 'auto';
    statusElement.style.padding = '0.5rem 1rem';
    statusElement.style.borderRadius = '4px';
    statusElement.style.fontSize = '0.9rem';
    
    const userInfo = document.querySelector('.user-info');
    if (userInfo) {
        userInfo.appendChild(statusElement);
    }
    
    return statusElement;
}

function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.position = 'fixed';
    notification.style.top = '20px';
    notification.style.right = '20px';
    notification.style.padding = '1rem';
    notification.style.borderRadius = '4px';
    notification.style.zIndex = '1000';
    notification.style.maxWidth = '300px';
    notification.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
    
    if (type === 'error') {
        notification.style.background = '#f8d7da';
        notification.style.color = '#721c24';
        notification.style.border = '1px solid #f5c6cb';
    } else if (type === 'success') {
        notification.style.background = '#d1edff';
        notification.style.color = '#0c5460';
        notification.style.border = '1px solid #bee5eb';
    } else {
        notification.style.background = '#fff3cd';
        notification.style.color = '#856404';
        notification.style.border = '1px solid #ffeaa7';
    }
    
    document.body.appendChild(notification);
    
    // Remove after 5 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 5000);
}

// Enhanced call functionality
function dialExtension() {
    const dialInput = document.getElementById('dialInput');
    const extension = dialInput.value.trim();
    
    if (!extension) {
        showNotification('Please enter an extension to dial', 'error');
        return;
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        showNotification(`Dialing ${extension}...`, 'info');
        
        ws.send(JSON.stringify({
            action: 'dial',
            extension: extension
        }));
        
        dialInput.value = ''; // Clear input after dialing
    } else {
        showNotification('Not connected to server', 'error');
    }
}

// Enhanced: Click to dial from extension buttons
function setupClickToDial() {
    document.addEventListener('click', function(e) {
        // Check if clicked on an extension element
        if (e.target.closest('.extension')) {
            const extensionElement = e.target.closest('.extension');
            const extensionNumber = extensionElement.querySelector('.number').textContent;
            const extensionStatus = extensionElement.querySelector('.status').textContent;
            
            // Don't dial if extension is busy or unavailable
            if (extensionStatus.toLowerCase() === 'busy') {
                showNotification(`Extension ${extensionNumber} is busy`, 'error');
                return;
            }
            
            if (extensionStatus.toLowerCase() === 'unavailable') {
                showNotification(`Extension ${extensionNumber} is unavailable`, 'error');
                return;
            }
            
            // Set the dial input and dial automatically
            const dialInput = document.getElementById('dialInput');
            dialInput.value = extensionNumber;
            dialExtension();
        }
    });
}

// Enhanced: Keyboard shortcuts
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
        // Ctrl+D or Cmd+D to focus dial input
        if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
            e.preventDefault();
            document.getElementById('dialInput').focus();
        }
        
        // Enter in dial input to dial
        if (e.key === 'Enter' && document.activeElement.id === 'dialInput') {
            dialExtension();
        }
        
        // Escape to clear dial input
        if (e.key === 'Escape' && document.activeElement.id === 'dialInput') {
            document.getElementById('dialInput').value = '';
        }
    });
}

// Enhanced active call tracking
function updateActiveCallStatus(callData) {
    const container = document.getElementById('activeCallContainer');
    const info = document.getElementById('activeCallInfo');
    
    if (callData) {
        currentActiveCall = callData;
        if (!container) {
            createActiveCallContainer();
        }
        document.getElementById('activeCallContainer').style.display = 'block';
        document.getElementById('activeCallInfo').textContent = 
            `Active call: ${currentUser ? currentUser.extension : 'You'} → ${callData.extension}`;
    } else {
        currentActiveCall = null;
        if (container) {
            container.style.display = 'none';
        }
    }
}

function createActiveCallContainer() {
    const actionBar = document.querySelector('.action-bar');
    if (!actionBar) return;
    
    const container = document.createElement('div');
    container.id = 'activeCallContainer';
    container.className = 'active-call-container';
    container.style.display = 'none';
    container.innerHTML = `
        <div class="active-call">
            <span id="activeCallInfo"></span>
            <button onclick="hangupActiveCall()" class="hangup-btn">Hangup</button>
        </div>
    `;
    
    actionBar.parentNode.insertBefore(container, actionBar.nextSibling);
}

function hangupActiveCall() {
    if (currentActiveCall && ws && ws.readyState === WebSocket.OPEN) {
        showNotification('Hangup requested - this would hangup the active call', 'info');
        
        // In a complete implementation, you'd send:
        // ws.send(JSON.stringify({
        //     action: 'hangup',
        //     channel: currentActiveCall.channel
        // }));
    } else {
        showNotification('No active call to hangup', 'error');
    }
}

// Extension management
function updateExtension(extension, status) {
    if (!extensions.has(extension)) {
        const extElement = document.createElement('div');
        extElement.className = `extension ${status.toLowerCase()}`;
        extElement.innerHTML = `
            <div class="number">${extension}</div>
            <div class="status">${status}</div>
            <div class="extension-actions">
                <button onclick="dialSpecificExtension('${extension}')" class="dial-small-btn">Dial</button>
            </div>
        `;
        document.getElementById('extensionsContainer').appendChild(extElement);
        extensions.set(extension, { element: extElement, status: status });
    } else {
        const extData = extensions.get(extension);
        extData.status = status;
        extData.element.className = `extension ${status.toLowerCase()}`;
        extData.element.querySelector('.status').textContent = status;
    }
}

function dialSpecificExtension(extension) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        showNotification(`Dialing ${extension}...`, 'info');
        ws.send(JSON.stringify({
            action: 'dial',
            extension: extension
        }));
    }
}

// Queue management
function updateQueueMember(data) {
    if (!queues.has(data.queue)) {
        queues.set(data.queue, { members: new Map(), entries: [] });
    }
    const queue = queues.get(data.queue);
    queue.members.set(data.member, data);
    renderQueue(data.queue);
}

function updateQueueEntry(data) {
    if (!queues.has(data.queue)) {
        queues.set(data.queue, { members: new Map(), entries: [] });
    }
    const queue = queues.get(data.queue);
    // Remove existing entries for this caller if any
    queue.entries = queue.entries.filter(entry => 
        entry.callerId !== data.callerId
    );
    queue.entries.push(data);
    renderQueue(data.queue);
}

function updateQueueStatus(data) {
    if (!queues.has(data.queue)) {
        queues.set(data.queue, { members: new Map(), entries: [] });
    }
    const queue = queues.get(data.queue);
    queue.stats = data;
    renderQueue(data.queue);
}

function renderQueue(queueName) {
    const queue = queues.get(queueName);
    let queueElement = document.getElementById(`queue-${queueName}`);
    
    if (!queueElement) {
        queueElement = document.createElement('div');
        queueElement.id = `queue-${queueName}`;
        queueElement.className = 'queue-item';
        document.getElementById('queuesContainer').appendChild(queueElement);
    }
    
    const waitingCalls = queue.entries ? queue.entries.length : 0;
    const activeAgents = queue.members ? Array.from(queue.members.values()).filter(m => m.status === '1').length : 0;
    const pausedAgents = queue.members ? Array.from(queue.members.values()).filter(m => m.paused === '1').length : 0;
    const totalAgents = queue.members ? queue.members.size : 0;
    
    queueElement.innerHTML = `
        <div class="queue-header">
            <h3>${queueName}</h3>
            <span class="queue-waiting">${waitingCalls} waiting</span>
        </div>
        <div class="queue-stats">
            <div class="stat">
                <div class="value">${activeAgents}</div>
                <div class="label">Active</div>
            </div>
            <div class="stat">
                <div class="value">${pausedAgents}</div>
                <div class="label">Paused</div>
            </div>
            <div class="stat">
                <div class="value">${waitingCalls}</div>
                <div class="label">Waiting</div>
            </div>
            <div class="stat">
                <div class="value">${queue.stats ? queue.stats.completed : 0}</div>
                <div class="label">Completed</div>
            </div>
        </div>
        <div class="agent-list">
            ${queue.members ? Array.from(queue.members.values()).map(member => `
                <div class="agent-item">
                    <span>${member.member}</span>
                    <span class="agent-status ${member.paused === '1' ? 'paused' : member.status === '1' ? 'busy' : 'idle'}">
                        ${member.paused === '1' ? 'Paused' : member.status === '1' ? 'Busy' : 'Idle'}
                    </span>
                </div>
            `).join('') : ''}
        </div>
    `;
}

// Active calls management
function addActiveCall(data) {
    const callId = data.channel1 + data.channel2;
    if (!activeCalls.has(callId)) {
        activeCalls.set(callId, data);
        renderActiveCalls();
    }
}

function renderActiveCalls() {
    const container = document.getElementById('callsContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (activeCalls.size === 0) {
        container.innerHTML = '<div class="no-calls">No active calls</div>';
        return;
    }
    
    activeCalls.forEach((call, callId) => {
        const callElement = document.createElement('div');
        callElement.className = 'call-item';
        callElement.innerHTML = `
            <div class="call-info">
                <strong>${call.callerId1 || 'Unknown'}</strong> → <strong>${call.callerId2 || 'Unknown'}</strong>
            </div>
            <div class="call-actions">
                <button onclick="spyCall('${call.channel1}')">Spy</button>
                <button onclick="whisperCall('${call.channel1}')">Whisper</button>
                <button onclick="transferCall('${call.channel1}')">Transfer</button>
                <button onclick="hangupCall('${call.channel1}')" class="hangup">Hangup</button>
            </div>
        `;
        container.appendChild(callElement);
    });
}

// Call control functions
function hangupCall(channel) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: 'hangup',
            channel: channel
        }));
        showNotification('Hangup requested', 'info');
    }
}

function transferCall(channel) {
    const target = prompt('Enter extension to transfer to:');
    if (target && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: 'transfer',
            channel: channel,
            target: target
        }));
        showNotification(`Transferring to ${target}`, 'info');
    }
}

function spyCall(channel) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: 'spy',
            channel: channel
        }));
        showNotification('Starting call spy', 'info');
    }
}

function whisperCall(channel) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: 'whisper',
            channel: channel
        }));
        showNotification('Starting whisper', 'info');
    }
}

function toggleQueuePause() {
    const queue = prompt('Enter queue name:');
    if (queue && ws && ws.readyState === WebSocket.OPEN) {
        const pause = confirm('Pause agent? OK for pause, Cancel for unpause');
        ws.send(JSON.stringify({
            action: 'pause',
            queue: queue,
            pause: pause
        }));
        showNotification(`${pause ? 'Pausing' : 'Unpausing'} in queue ${queue}`, 'info');
    }
}

// Dialpad functionality
function showDialpad() {
    // Create modal if it doesn't exist
    if (!document.getElementById('dialpadModal')) {
        createDialpadModal();
    }
    document.getElementById('dialpadModal').style.display = 'block';
}

function createDialpadModal() {
    const modal = document.createElement('div');
    modal.id = 'dialpadModal';
    modal.className = 'modal';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content">
            <span class="close" onclick="closeDialpad()">&times;</span>
            <h3>Dialpad</h3>
            <div class="dialpad-display">
                <input type="text" id="dialpadInput" readonly style="width: 100%; padding: 0.5rem; margin-bottom: 1rem; text-align: center; font-size: 1.2rem; border: 1px solid #ddd; border-radius: 4px;">
            </div>
            <div class="dialpad">
                <div class="dialpad-row">
                    <button class="dialpad-btn" onclick="appendToDial('1')">1</button>
                    <button class="dialpad-btn" onclick="appendToDial('2')">2</button>
                    <button class="dialpad-btn" onclick="appendToDial('3')">3</button>
                </div>
                <div class="dialpad-row">
                    <button class="dialpad-btn" onclick="appendToDial('4')">4</button>
                    <button class="dialpad-btn" onclick="appendToDial('5')">5</button>
                    <button class="dialpad-btn" onclick="appendToDial('6')">6</button>
                </div>
                <div class="dialpad-row">
                    <button class="dialpad-btn" onclick="appendToDial('7')">7</button>
                    <button class="dialpad-btn" onclick="appendToDial('8')">8</button>
                    <button class="dialpad-btn" onclick="appendToDial('9')">9</button>
                </div>
                <div class="dialpad-row">
                    <button class="dialpad-btn" onclick="appendToDial('*')">*</button>
                    <button class="dialpad-btn" onclick="appendToDial('0')">0</button>
                    <button class="dialpad-btn" onclick="appendToDial('#')">#</button>
                </div>
                <div class="dialpad-actions">
                    <button onclick="dialFromDialpad()" class="dial-btn">Dial</button>
                    <button onclick="clearDialpad()" class="clear-btn">Clear</button>
                    <button onclick="closeDialpad()" class="clear-btn">Close</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function appendToDial(digit) {
    const dialInput = document.getElementById('dialInput');
    const dialpadInput = document.getElementById('dialpadInput');
    
    dialInput.value += digit;
    if (dialpadInput) {
        dialpadInput.value += digit;
    }
}

function closeDialpad() {
    document.getElementById('dialpadModal').style.display = 'none';
}

function clearDialpad() {
    const dialInput = document.getElementById('dialInput');
    const dialpadInput = document.getElementById('dialpadInput');
    
    dialInput.value = '';
    if (dialpadInput) {
        dialpadInput.value = '';
    }
}

function clearDial() {
    const dialInput = document.getElementById('dialInput');
    dialInput.value = '';
    dialInput.focus();
}

function dialFromDialpad() {
    closeDialpad();
    dialExtension();
}

// Initialize enhanced calling features
function initializeCallFeatures() {
    setupClickToDial();
    setupKeyboardShortcuts();
    
    // Add hint to dial input
    const dialInput = document.getElementById('dialInput');
    if (dialInput) {
        dialInput.placeholder = 'Enter extension or click on extension below...';
        dialInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                dialExtension();
            }
        });
    }
    
    // Create dialpad button if it doesn't exist
    if (!document.getElementById('dialpadBtn')) {
        const actionBar = document.querySelector('.action-bar');
        if (actionBar) {
            const dialpadBtn = document.createElement('button');
            dialpadBtn.id = 'dialpadBtn';
            dialpadBtn.textContent = 'Dialpad';
            dialpadBtn.onclick = showDialpad;
            dialpadBtn.style.marginLeft = 'auto';
            actionBar.appendChild(dialpadBtn);
        }
    }
}

function logout() {
    fetch('/logout', { method: 'POST' })
        .then(() => {
            window.location.href = '/';
        });
}

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('dialpadModal');
    if (modal && event.target === modal) {
        closeDialpad();
    }
}

// Auto-reconnect when page becomes visible
document.addEventListener('visibilitychange', function() {
    if (!document.hidden && (!ws || ws.readyState === WebSocket.CLOSED)) {
        console.log('Page became visible, reconnecting WebSocket...');
        connectWebSocket();
    }
});

// Add to your WebSocket message handler in app.js
case 'incomingCall':
    showIncomingCall(data);
    break;
case 'callAnswered':
    updateCallAnswered(data);
    break;
case 'callCompleted':
    updateCallCompleted(data);
    break;

// Inbound call handling functions
function showIncomingCall(callData) {
    log(LOG_LEVELS.INFO, 'Showing incoming call', callData);
    
    // Create or update incoming call notification
    let incomingCallElement = document.getElementById('incomingCall');
    
    if (!incomingCallElement) {
        incomingCallElement = document.createElement('div');
        incomingCallElement.id = 'incomingCall';
        incomingCallElement.className = 'incoming-call-alert';
        incomingCallElement.innerHTML = `
            <div class="incoming-call-content">
                <div class="caller-info">
                    <div class="caller-number">${callData.callerId}</div>
                    <div class="caller-name">${callData.callerIdName}</div>
                    <div class="call-status">Incoming call to ${callData.extension}</div>
                </div>
                <div class="call-actions">
                    <button onclick="answerCall('${callData.channel}', '${callData.extension}')" class="answer-btn">Answer</button>
                    <button onclick="rejectCall('${callData.channel}')" class="reject-btn">Reject</button>
                </div>
            </div>
        `;
        
        // Add to the top of the container
        const container = document.querySelector('.container');
        if (container) {
            container.insertBefore(incomingCallElement, container.firstChild);
        }
    }
    
    // Flash the extension that's ringing
    const extensionElement = document.querySelector(`.extension .number:contains("${callData.extension}")`)?.closest('.extension');
    if (extensionElement) {
        extensionElement.classList.add('ringing');
        extensionElement.style.animation = 'pulse 1s infinite';
    }
}

function updateCallAnswered(callData) {
    log(LOG_LEVELS.INFO, 'Call answered', callData);
    
    // Remove incoming call alert
    const incomingCallElement = document.getElementById('incomingCall');
    if (incomingCallElement) {
        incomingCallElement.remove();
    }
    
    // Update extension status to busy
    if (callData.calleeExtension) {
        updateExtension(callData.calleeExtension, 'inuse');
    }
    if (callData.callerExtension) {
        updateExtension(callData.callerExtension, 'inuse');
    }
    
    showNotification(`Call answered: ${callData.callerExtension} → ${callData.calleeExtension}`, 'success');
}

function updateCallCompleted(callData) {
    log(LOG_LEVELS.INFO, 'Call completed', callData);
    
    // Update extension status to idle
    updateExtension(callData.extension, 'idle');
    
    // Remove any ringing animation
    const extensionElement = document.querySelector(`.extension .number:contains("${callData.extension}")`)?.closest('.extension');
    if (extensionElement) {
        extensionElement.classList.remove('ringing');
        extensionElement.style.animation = '';
    }
    
    showNotification(`Call ended: ${callData.extension} (${callData.duration}s)`, 'info');
}

// Call control functions for inbound calls
function answerCall(channel, extension) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        // For PJSIP channels, we need to answer the channel
        ws.send(JSON.stringify({
            action: 'answer',
            channel: channel,
            extension: extension
        }));
        log(LOG_LEVELS.INFO, 'Answering call', { channel: channel, extension: extension });
    }
}

function rejectCall(channel) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: 'hangup',
            channel: channel
        }));
        log(LOG_LEVELS.INFO, 'Rejecting call', { channel: channel });
    }
    
    // Remove incoming call alert
    const incomingCallElement = document.getElementById('incomingCall');
    if (incomingCallElement) {
        incomingCallElement.remove();
    }
}
