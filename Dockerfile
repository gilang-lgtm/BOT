# Tanpa dependensi npm, jadi tidak ada langkah "npm install".
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY *.js ./
CMD ["node", "server.js"]
