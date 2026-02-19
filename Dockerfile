FROM node:22-alpine

WORKDIR /app

# better-sqlite3 is a native addon — needs build tools on Alpine
RUN apk add --no-cache python3 make g++

# Install dependencies first (cached layer when only source changes)
COPY package*.json ./
RUN npm install

# Source code is NOT copied here — it is bind-mounted at runtime via compose.yaml.
# This keeps the image lean and enables live-editing without rebuilds.

EXPOSE 3000

# nodemon watches for file changes and restarts automatically
CMD ["npm", "run", "dev"]
