import { app } from 'electron';
console.log('MIN-START');
app.disableHardwareAcceleration();
app.whenReady().then(() => { console.log('MIN-READY'); app.exit(0); });
setTimeout(() => { console.log('MIN-TIMEOUT'); app.exit(1); }, 20000);
