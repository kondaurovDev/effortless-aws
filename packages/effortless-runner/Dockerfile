FROM node:24-alpine

RUN apk add --no-cache unzip

WORKDIR /app

COPY package.json /app/package.json
RUN npm install --omit=dev

COPY entrypoint.mjs /app/entrypoint.mjs

ENTRYPOINT ["node", "/app/entrypoint.mjs"]
