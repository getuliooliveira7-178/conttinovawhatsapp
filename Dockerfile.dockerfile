FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
    chromium \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
    libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 \
    libdrm2 libgbm1 libasound2 fonts-liberation xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci || npm i
COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

CMD ["npm","start"]
