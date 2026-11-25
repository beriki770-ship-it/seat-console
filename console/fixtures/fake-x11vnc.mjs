#!/usr/bin/env node
// A stand-in for x11vnc in test-desktop.mjs: listens on the -unixsock path it is given, greets like a VNC server ("RFB 003.008\n") and echoes
// every byte back, so the test sees both directions of the /ws/desktop proxy without an X display.
import net from 'node:net';
const sock = process.argv[process.argv.indexOf('-unixsock') + 1];
net.createServer((c) => { c.write('RFB 003.008\n'); c.on('data', (d) => c.write(d)); c.on('error', () => {}); }).listen(sock);
