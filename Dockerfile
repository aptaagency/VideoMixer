# Use official Node.js image based on Debian slim
FROM node:18-slim

# Install FFmpeg and clean up apt caches to keep image small
RUN apt-get update && apt-get install -y ffmpeg && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set working directory inside the container
WORKDIR /app

# Copy package files and install dependencies first (better caching)
COPY package*.json ./
RUN npm install --production

# Copy the rest of your app source code
COPY . .

# Expose the port your app listens on
EXPOSE 3000

# Start your app
CMD ["node", "index.js"]
