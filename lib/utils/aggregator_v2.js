class AggregatorV2 {
    constructor(interval, batchSize, batchProcessor) {
        this.eventQueue = [];
        this.initialInterval = interval;
        this.currentInterval = interval;
        this.batchSize = batchSize;
        this.batchProcessor = batchProcessor;

        this.maxInterval = interval * 5;
        this.intervalStep = interval * 0.5;
        this.resetTimeout = 90000;
        this.resetTimer = null;
    }

    start() {
        this._startProcessing();
    }

    stop() {
        clearInterval(this.timer);
        this._clearResetMonitor();
        if (this.eventQueue.length > 0) {
            this.batchProcessor(this.eventQueue);
        }
    }

    enqueue(item) {
        this.eventQueue.push(item);

        if (this.eventQueue.length >= this.batchSize) {
            this.batchProcessor([...this.eventQueue]);
            this.eventQueue = [];
        }
    }

    increaseInterval() {
        const newInterval = this.currentInterval + this.intervalStep;

        if (newInterval <= this.maxInterval) {
            this.currentInterval = newInterval;
            // console.log(`Interval increased to: ${this.currentInterval}ms`);

            this._startResetMonitor();

            this._restartProcessing();
        } else {
            // console.log(`Interval reached maximum: ${this.maxInterval}ms`);
        }

        return this.currentInterval;
    }

    resetInterval() {
        if (this.currentInterval !== this.initialInterval) {
            this.currentInterval = this.initialInterval;
            // console.log(`Interval reset to: ${this.currentInterval}ms`);

            this._clearResetMonitor();

            this._restartProcessing();
        }
        return this.currentInterval;
    }

    _startProcessing() {
        this.timer = setInterval(() => {
            if (this.eventQueue.length === 0) return;
            this.batchProcessor([...this.eventQueue]);
            this.eventQueue = [];
        }, this.currentInterval);
    }

    _restartProcessing() {
        clearInterval(this.timer);
        this._startProcessing();
    }

    _startResetMonitor() {
        this._clearResetMonitor();

        this.resetTimer = setTimeout(() => {
            // console.log(`No increaseInterval calls for ${this.resetTimeout}ms, resetting interval`);
            this.resetInterval();
        }, this.resetTimeout);
    }

    _clearResetMonitor() {
        if (this.resetTimer) {
            clearTimeout(this.resetTimer);
            this.resetTimer = null;
        }
    }

    configure(options = {}) {
        if (options.maxInterval !== undefined) {
            this.maxInterval = options.maxInterval;
        }
        if (options.intervalStep !== undefined) {
            this.intervalStep = options.intervalStep;
        }
        if (options.resetTimeout !== undefined) {
            this.resetTimeout = options.resetTimeout;
        }
    }
}

module.exports = AggregatorV2
