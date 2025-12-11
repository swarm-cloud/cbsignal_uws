FROM node:20-slim

#RUN npm install pm2 -g
WORKDIR /cbsignal_uws
#COPY package*.json ./

COPY . /cbsignal_uws/
RUN yarn install

CMD [ "node", "--expose-gc", "index.js", "config.yaml"]

