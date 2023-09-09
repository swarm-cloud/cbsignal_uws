

class Aggregator {
    constructor(interval, batchSize, batchProcessor) {
        this.eventQueue = [];
        this.interval = interval;
        this.batchSize = batchSize;
        this.batchProcessor = batchProcessor;
    }

    start() {
        this.timer = setInterval(() => {
            if (this.eventQueue.length === 0) return
            this.batchProcessor(this.eventQueue);
            this.eventQueue = [];
        }, this.interval);
    }

    stop() {
        clearInterval(this.timer);
        if (this.eventQueue.length > 0) {
            this.batchProcessor(this.eventQueue);
            this.eventQueue = [];
        }
    }

    enqueue(item) {
        this.eventQueue.push(item);
        if (this.eventQueue.length >= this.batchSize) {
            this.batchProcessor(this.eventQueue);
            this.eventQueue = [];
        }
    }

}

module.exports = Aggregator
