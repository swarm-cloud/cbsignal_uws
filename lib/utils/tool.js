const fs = require('fs');
const os = require('os');
const { Certificate } = require('@fidm/x509');

function getCertInfo(cert) {
    const caCert = fs.readFileSync(cert);
    const issuer = Certificate.fromPEM(caCert);
    return  {
        name: issuer.subject.attributes[0].value,
        expire_at: issuer.validTo,
    }
}

//Create function to get CPU information
function cpuAverage() {

    //Initialise sum of idle and time of cores and fetch CPU info
    var totalIdle = 0, totalTick = 0;
    var cpus = os.cpus();

    //Loop through CPU cores
    for (var i = 0, len = cpus.length; i < len; i++) {

        //Select CPU core
        var cpu = cpus[i];

        //Total up the time in the cores tick
        for (let type in cpu.times) {
            totalTick += cpu.times[type];
        }

        //Total up the idle time of the core
        totalIdle += cpu.times.idle;
    }

    //Return the average Idle and Tick times
    return {idle: totalIdle / cpus.length, total: totalTick / cpus.length};
}

// function to calculate average of array
const arrAvg = function (arr) {
    if (arr && arr.length >= 1) {
        const sumArr = arr.reduce((a, b) => a + b, 0)
        return sumArr / arr.length;
    }
};

// load average for the past 1000 milliseconds calculated every 100
function getCPULoadAVG(avgTime = 1000, delay = 100) {
    return new Promise((resolve, reject) => {
        const n = ~~(avgTime / delay);
        if (n <= 1) {
            reject('Error: interval to small');
        }
        let i = 0;
        let samples = [];
        const avg1 = cpuAverage();
        let interval = setInterval(() => {
            if (i >= n) {
                clearInterval(interval);
                resolve(~~((arrAvg(samples) * 100)));
            }
            const avg2 = cpuAverage();
            const totalDiff = avg2.total - avg1.total;
            const idleDiff = avg2.idle - avg1.idle;
            samples[i] = (1 - idleDiff / totalDiff);
            i++;
        }, delay);
    });
}

function getLocalIp(){
    const networkInterfaces = os.networkInterfaces()
    let ip = ''
    Object.values(networkInterfaces).forEach(list=>{
        list.forEach(ipInfo => {
            if(ipInfo.family === 'IPv4' && ipInfo.address !== '127.0.0.1' && !ipInfo.internal){
                ip = ipInfo.address
            }
        })
    })
    return ip
}

function getWorkerAddr(pid) {
    return `${getLocalIp()}-${pid}`
}

function getSelfAddr() {
    return getWorkerAddr(process.pid)
}

function getVersionNum(ver) {
    const digs = ver.split(".");
    return Number(digs[0])*10 + Number(digs[1])
}

module.exports = {
    getCertInfo,
    getCPULoadAVG,
    getLocalIp,
    getSelfAddr,
    getWorkerAddr,
    getVersionNum,
}
