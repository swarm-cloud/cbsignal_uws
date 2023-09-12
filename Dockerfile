FROM node:18-slim

#RUN npm install pm2 -g
WORKDIR /cbsignal_uws
#COPY package*.json ./

COPY . /cbsignal_uws/
RUN yarn install

CMD [ "node", "index.js", "config.yaml"]

