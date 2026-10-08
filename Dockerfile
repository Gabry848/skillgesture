FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY db ./db
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
