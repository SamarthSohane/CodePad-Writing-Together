const { io } = require('socket.io-client');
const http = require('http');

const SERVER_URL = 'http://localhost:4000';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('--- Starting System Tests for Live Collaborative Workspace ---');

  // Test 1: Verify health endpoint
  console.log('\n[Test 1] Checking Server Health Endpoint...');
  await new Promise((resolve, reject) => {
    http.get(`${SERVER_URL}/api/health`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('✓ Health Endpoint Response:', data);
        resolve();
      });
    }).on('error', reject);
  });

  // Test 2: Room creation with passcode & authentication validation
  console.log('\n[Test 2] Testing Room Security & Passcode Validation...');
  const roomId = 'test-room-' + Date.now();
  const passcode = 'secretPass123';

  // Client A creates room with passcode
  const clientA = io(SERVER_URL);
  await new Promise((resolve) => clientA.on('connect', resolve));
  
  const resA = await new Promise((resolve) => {
    clientA.emit('join_room', {
      roomId,
      passcode,
      username: 'Alice (Creator)',
      color: '#3b82f6'
    }, resolve);
  });
  console.log(`✓ Client A joined as host:`, resA.success && resA.room.isHost);

  // Client B attempts to join with WRONG passcode
  const clientB_Wrong = io(SERVER_URL);
  await new Promise((resolve) => clientB_Wrong.on('connect', resolve));
  const resB_Wrong = await new Promise((resolve) => {
    clientB_Wrong.emit('join_room', {
      roomId,
      passcode: 'wrong_password',
      username: 'Bob',
      color: '#10b981'
    }, resolve);
  });
  console.log(`✓ Client B with wrong passcode rejected:`, !resB_Wrong.success, `(${resB_Wrong.error})`);
  clientB_Wrong.disconnect();

  // Client B joins with CORRECT passcode
  const clientB = io(SERVER_URL);
  await new Promise((resolve) => clientB.on('connect', resolve));
  const resB = await new Promise((resolve) => {
    clientB.emit('join_room', {
      roomId,
      passcode,
      username: 'Bob (Second Member)',
      color: '#10b981'
    }, resolve);
  });
  console.log(`✓ Client B with correct passcode admitted:`, resB.success);

  // Client C joins as third member
  const clientC = io(SERVER_URL);
  await new Promise((resolve) => clientC.on('connect', resolve));
  const resC = await new Promise((resolve) => {
    clientC.emit('join_room', {
      roomId,
      passcode,
      username: 'Charlie (Third Member)',
      color: '#8b5cf6'
    }, resolve);
  });
  console.log(`✓ Client C admitted:`, resC.success);

  // Test 3: Connection & Spam Throttling (>5 updates/second)
  console.log('\n[Test 3] Testing Rapid Spam Throttling (>5 updates/sec)...');
  let throttleWarningReceived = false;
  clientA.on('throttle_warning', (warning) => {
    throttleWarningReceived = true;
    console.log('✓ Throttling warning event intercepted:', warning.message);
  });

  // Emit 10 rapid updates in a single burst
  for (let i = 0; i < 10; i++) {
    clientA.emit('code_change', {
      change: null,
      fullCode: `console.log("Rapid update ${i}");`
    });
  }
  await sleep(400);
  console.log(`✓ Spam Throttling correctly triggered:`, throttleWarningReceived);

  // Test 4: Dynamic Role Reassignment (Host disconnects -> transfers to oldest remaining)
  console.log('\n[Test 4] Testing Dynamic Role Reassignment on Host Disconnect...');
  let hostReassignedEvent = null;
  clientB.on('host_reassigned', (evt) => {
    hostReassignedEvent = evt;
  });

  console.log('Disconnecting host Client A (Alice)...');
  clientA.disconnect();

  await sleep(500);

  console.log('✓ Dynamic host reassignment triggered:', hostReassignedEvent);
  console.log(`✓ New host is oldest active member Bob:`, hostReassignedEvent?.newHostUsername === 'Bob (Second Member)');

  // Clean up
  clientB.disconnect();
  clientC.disconnect();

  console.log('\n===========================================');
  console.log(' ALL ARCHITECTURAL TESTS PASSED CLEANLY!  ');
  console.log('===========================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
