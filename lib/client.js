
const POLLING_QUEUE_SIZE   = 30
const WS_EXPIRE_LIMIT = 11 * 60 * 1000
const POLLING_EXPIRE_LIMIT = 3 * 60 * 1000

class Client {
    constructor(writer, peerId, isPolling, isCompact, device, batchable) {
        if (isPolling) {
            this._httpWriter = writer;
        } else {
            this._ws  = writer;
        }
        this.peerId = peerId;
        this.timestamp = Date.now();
        this.isPolling = isPolling;
        this.isCompact = isCompact;
        this.batchable = batchable;
        this.msgQueue = [];
        this.onAborted = null;
        this.timer = null;
        this.device = device    // android  ios web
        this.notFoundIdCache = '';
    }

    switchToWS(ws) {
        clearTimeout(this.timer);
        this._ws = ws;
        this._httpWriter = null;
        this.isPolling = false;
    }

    switchToPolling(writer) {
        this._httpWriter = writer;
        this._ws = null;
        this.isPolling = true;
    }

    updateTs() {
        this.timestamp = Date.now();
    }

    isExpired(now) {
        if (this.isPolling) {
            return now - this.timestamp > POLLING_EXPIRE_LIMIT
        }
        return now - this.timestamp > WS_EXPIRE_LIMIT
    }

    sendMessage(msg) {
        if (this.isPolling) {
            return this.sendDataPolling(msg)
        }
        return this.sendDataWs(msg)
    }

    sendDataPolling(msg) {
        const json = JSON.parse(msg);
        if (this.msgQueue.length >= POLLING_QUEUE_SIZE) {
            return false
        }
        this.msgQueue.push(json);
        if (this.timer) return true
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this._httpWriter && this.msgQueue.length > 0) {
                if (this.onAborted) {
                    this.onAborted();
                    this.onAborted = null;
                }
                this._httpWriter = null;
                this.msgQueue = [];
            }
        }, 200)
        return true
    }

    sendDataWs(msg) {
        if (this._ws && !this._ws.closed) {
            try {
                const code = this._ws.send(msg, false, false);
                if (code === 2) {
                    console.error(`ws dropped due to backpressure limit`);
                }
            } catch (e) {
                // console.warn(e);
                return false
            }
            return true
        }
        return false
    }

    close() {
        if (this.isPolling) {
            clearTimeout(this.timer);
            if (this._httpWriter) {
                if (this.onAborted) {
                    this.onAborted();
                }
                this._httpWriter = null;
            }
        } else if (this._ws) {
            this._ws.close()
            this._ws = null;
        }
    }

}

module.exports = Client
