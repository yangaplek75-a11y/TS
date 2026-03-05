# Pakai mesin Node.js versi Alpine (Versi paling ringan sedunia, irit RAM)
FROM node:18-alpine

WORKDIR /app

# Pindahkan file konfigurasi dan install library
COPY package*.json ./
RUN npm install

# Pindahkan sisa file kodingan
COPY . .

# Jalankan pabriknya!
CMD ["npm", "start"]