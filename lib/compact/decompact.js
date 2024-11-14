const FingerprintToBase64 = require("./base64.js");
const {
    AttributeRepalceMapReverse,
    FieldReplaceMapReverse,
    HashFuncMapReverse,
    MediaConnectionAddressTypeMapReverse,
    MediaConnectionIPMapReverse,
    candidateDecode,
    mediaDecode,
} = require("./dict.js");

module.exports = (compacted) => {

    const isCandidate = compacted[0] === "C";

    if (isCandidate) {
        return {
            type: "candidate",
            candidate: {
                candidate: decompactCond(compacted),
                sdpMLineIndex: 0,
                sdpMid: "0"
            }
        };
    }
    const minStr = compacted.slice(1);
    const isOffer = compacted[0] === "O";
    return {
        type: isOffer ? "offer" : "answer",
        sdp: decompactSDPStr(minStr, isOffer),
    };
};

const decompactCond = (
        compactCondStr,
    ) => {
    return candidateDecode(compactCondStr);
}

function decompactSDPStr(
    compactSDPStr,
    isOffer,
) {
    let compactSDP = compactSDPStr.split("~");
    let decompactSDP = [];

    compactSDP = compactSDP.map((line) => {
        let field = line.slice(0, 1);
        let value = line.slice(1);

        if (field in FieldReplaceMapReverse) {
            field = FieldReplaceMapReverse[field];
        }

        // replace attributes
        if (field === "a=") {
            let attr = value.slice(0, 1);
            const subValue = value.slice(1);

            if (attr in AttributeRepalceMapReverse) {
                attr = AttributeRepalceMapReverse[attr];
                value = attr + subValue;
            }
        }

        return field + value;
    });

    decompactSDP.push(`v=0`);

    decompactSDP.push(`s=-`);

    decompactSDP.push(`t=0 0`);

    decompactSDP.push(`a=extmap-allow-mixed`);

    decompactSDP.push(`a=msid-semantic: WMS`);

    let mediaID = 0;
    compactSDP.forEach((line) => {
        // origin
        if (line.startsWith("o=")) {
            // `o=<username> <sessID> <sessVersion> <netType> <addrType> <unicastAddress>`
            let origin = line.slice(2).split(" ");
            let newOrgin = [];

            // username
            newOrgin.push("-");

            // sessionId
            const f = origin.shift();
            if (f) newOrgin.push(f);

            if (origin.length === 0) {
                newOrgin.push('2 IN IP4 127.0.0.1');
            } else {
                // sessVersion
                const f0 = origin.shift();
                if (f0) newOrgin.push(f0);

                if (origin.length === 0) {
                    newOrgin.push('IN IP4 127.0.0.1');
                } else {
                    newOrgin.push("IN");

                    // addrtype
                    const f1 = origin.shift();
                    if (f1) newOrgin.push(f1);

                    // unicastAddress
                    const f2 = origin.shift();
                    if (f2) newOrgin.push(f2);
                }
            }

            decompactSDP.splice(1, 0, `o=${newOrgin.join(" ")}`);
            return;
        }

        // media
        if (line.startsWith("m=")) {
            // replace media string
            line = mediaDecode(line);

            decompactSDP.push(line);

            decompactSDP.push(`a=setup:${isOffer ? "actpass" : "active"}`);

            decompactSDP.push(`a=mid:${mediaID}`);
            mediaID++;

            return;
        }

        if (
            line.startsWith("a=candidate:")
        ) {
            line = candidateDecode(line);
            decompactSDP.push(line);
            return;
        }

        if (
            line.startsWith("a=fingerprint:")
        ) {
            let [hashMethod, fingerprint] = line.slice(14).split(" ");
            if (hashMethod in HashFuncMapReverse) {
                hashMethod = HashFuncMapReverse[hashMethod];
            }
            fingerprint = FingerprintToBase64.decode(fingerprint);
            decompactSDP.push(`a=fingerprint:${hashMethod} ${fingerprint}`);
            return;
        }

        if (line.startsWith("c=")) {
            let [addressType, ip] = line.slice(2).split(" ");
            if (addressType in MediaConnectionAddressTypeMapReverse) {
                addressType = MediaConnectionAddressTypeMapReverse[addressType];
            }
            if (ip in MediaConnectionIPMapReverse) {
                ip = MediaConnectionIPMapReverse[ip];
            }
            // network type (IN for Internet), address type (IP4), and the connection address (115.87.239.220)
            decompactSDP.push(`c=IN ${addressType} ${ip}`);
            return;
        }

        if (line === "I") {
            decompactSDP.push("a=ice-options:trickle");
            return;
        }

        if (line === "Z") {
            decompactSDP.push("a=ice-options:ice2,trickle");
            return;
        }

        if (line === "B") {
            decompactSDP.push("a=sendrecv");
            return;
        }

        decompactSDP.push(line);
    });

    const index = decompactSDP.length - 1; // 倒数第二个位置的索引
    decompactSDP.splice(index, 0, `a=group:BUNDLE ${Array.from(Array(mediaID).keys()).join(" ")}`); // 在该位置插入元素

    return decompactSDP.join("\r\n");

}
