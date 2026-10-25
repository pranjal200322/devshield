# Small production image. node:20-alpine keeps the image tiny.
FROM node:20-alpine
WORKDIR /app
# Copy manifests first so Docker caches the npm install layer
# unless dependencies actually change.
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
# Run as the unprivileged "node" user, not root.
USER node
CMD ["node", "src/server.js"]
