# Use Node.js 20 image as base
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Expose port ( Railway provides $PORT dynamically )
EXPOSE 3000

# Start the application
CMD ["node", "dist/main"]