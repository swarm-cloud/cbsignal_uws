if (isMainThread) {
    program
        .name('cbsignal_uws')
        .description('SwarmCloud signaling server using uWebSockets.js')
        .version(pkg.version, '-v, --version', 'output the current version')
        .option('-c, --config [p]', 'The yaml file for config', 'config.yaml');
    program.parse(process.argv);
    const options = program.opts();
    const configObject = YAML.load(options.config);
    // console.warn(configObject)

    if (os.cpus().length <= 1) {
    // if (true) {
        // do not start worker thread and use redis
        startWorker(configObject)
    } else {
        /* Main thread loops over all CPUs */
        /* In this case we only spawn two (hardcoded) */
        os.cpus().forEach(() => {
            /* Spawn a new thread running this source file */
            const worker = new Worker(__filename, { workerData: configObject });
            setupListener(worker);
        });
    }

} else {
    startWorker(workerData)
}
