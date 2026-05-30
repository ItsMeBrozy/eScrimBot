# Clean production environment
FROM node:20

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

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
