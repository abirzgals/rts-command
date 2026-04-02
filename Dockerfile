FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx vite build

FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
RUN apk del python3 make g++
COPY server.mjs ./
COPY --from=build /app/dist ./dist
EXPOSE 80
ENV PORT=80
CMD ["node", "server.mjs"]
