
const POLLING_QUEUE_SIZE   = 30
const WS_EXPIRE_LIMIT = 11 * 60 * 1000
const POLLING_EXPIRE_LIMIT = 3 * 60 * 1000
const MAX_NOT_FOUND_PEERS_LIMIT = 3;

class Client {
    constructor(writer, peerId, isPolling) {
        if (isPolling) {
            this._httpWriter = writer;
        } else {
            this._ws  = writer;
        }
        this.peerId = peerId;
        this.timestamp = Date.now();
        this.isPolling = isPolling;
        this.msgQueue = [];
        this.notFoundPeers = [];
        this.onAborted = null;
    }

    switchToWS(ws) {
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
        if (this._httpWriter && this.msgQueue.length > 0) {
            this._httpWriter.end(JSON.stringify(this.msgQueue));
            this._httpWriter = null;
            this.msgQueue = [];
            if (this.onAborted) {
                this.onAborted();
            }
        }
        return true
    }

    sendDataWs(msg) {
        if (this._ws) {
            this._ws.send(msg, false, false);
            return true
        }
        return false
    }

    close() {
        if (this.isPolling && this._httpWriter) {
            this._httpWriter.cork(() => {
                this._httpWriter.end();
                this._httpWriter = null;
            });
            if (this.onAborted) {
                this.onAborted();
            }
            return
        }
        return this._ws.close()
    }

    filterAdd(toPeerId) {
        if (this.notFoundPeers.includes(toPeerId)) return
        this.notFoundPeers.push(toPeerId);
        if (this.notFoundPeers.length > MAX_NOT_FOUND_PEERS_LIMIT) {
            this.notFoundPeers.shift();
        }
    }

}

module.exports = Client
