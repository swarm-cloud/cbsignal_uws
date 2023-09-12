
# SwarmCloud signaling server using uWebSockets.js

## Configuration
See config/config.yaml

## Run instructions

### Run with Docker
```sh
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo docker run --name cbsignal_uws --net host --restart=unless-stopped -d cdnbye/cbsignal_uws:latest
```
Or run in cluster mode, make sure that redis server is running:
```sh
# docker run -p 6379:6379 --name my-redis -d redis
sudo docker run --name cbsignal_uws \
-e REDIS_URL=redis://127.0.0.1:6379 \
-e PORT=80 \
--net host --restart=unless-stopped -d cdnbye/cbsignal_uws:latest
```
You can enable SSL also, make a directory called "cert", then put your cert file in it, run:
```sh
sudo docker run --name cbsignal_uws \
-e REDIS_URL=redis://127.0.0.1:6379 \
-e TLS_PORT=443 -e CERT_PATH=cert/fullchain.cer -e KEY_PATH=cert/cert.key \
-v "$(pwd)"/cert:/cbsignal_uws/cert \
--net host --restart=unless-stopped -d cdnbye/cbsignal_uws:latest
```

### Run with Source
```sh
git clone https://github.com/swarm-cloud/cbsignal_uws.git
cd cbsignal_uws
npm install
npm run start
```

### Get real-time information of signal service
```
GET /info
```

