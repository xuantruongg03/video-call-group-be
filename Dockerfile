FROM node:22
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    make \
    g++ \
 && rm -rf /var/lib/apt/lists/*
# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Expose both ports that the app runs on
EXPOSE 3000
EXPOSE 3002

# Start the application
CMD ["npm", "run", "start"]