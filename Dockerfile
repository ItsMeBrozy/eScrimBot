# Clean production environment
FROM node:20

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Update system certificates and install tools for better TLS support
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Force Node.js to use the system certificate store for TLS connections
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Expose the port Hugging Face expects
EXPOSE 7860

# Start the application
CMD ["npm", "start"]
