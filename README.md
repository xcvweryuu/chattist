# Chattist 💬

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

Chattist is a lightweight, professional private messaging web application designed for secure and real-time communication. Built with a focus on simplicity and performance, it provides a seamless chat experience directly in your browser.

**Live Demo:** [chattist.org](https://chattist.org)

## ✨ Features

- **User Authentication:** Secure sign-up and login system powered by JWT and bcrypt.
- **Real-time Messaging:** Instant message delivery using WebSockets for a fluid conversation flow.
- **Direct & Group Chats:** Support for one-on-one private messaging and collaborative group conversations.
- **Security First:** Implements rate limiting, XSS protection, and secure HTTP headers.
- **Responsive Design:** Clean, modern interface built with vanilla HTML/CSS/JS that works across devices.

## 🚀 Tech Stack

- **Frontend:** Vanilla HTML5, CSS3, JavaScript (ES6+)
- **Backend:** Node.js, Express.js
- **Real-time:** WebSockets (`ws`)
- **Database:** SQLite (`better-sqlite3`)
- **Security:** JSON Web Tokens (JWT), bcryptjs, Helmet, Express Rate Limit

## 🛠️ Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v14 or higher recommended)
- npm (comes with Node.js)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/chattist.git
   cd chattist
   ```

2. **Install dependencies:**
   ```bash
   cd server
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the `server` directory based on `.env.example`:
   ```bash
   cp .env.example .env
   ```

4. **Run the application:**
   ```bash
   # Start the server (includes serving frontend)
   npm start
   
   # For development with auto-reload
   npm run dev
   ```

The application will be available at `http://localhost:3000` (or your configured port).

## ⚙️ Environment Variables

The following variables are required in your `server/.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | The port the server will listen on | `3000` |
| `JWT_SECRET` | Secret key for signing JSON Web Tokens | `REQUIRED` |
| `CORS_ORIGIN` | Allowed origin for CORS (e.g., your domain) | `http://localhost:3000` |
| `NODE_ENV` | Environment mode (`development` or `production`) | `development` |

## 🌐 Deployment

This application is configured for easy deployment on [Railway](https://railway.app/). 

1. Push your code to a GitHub repository.
2. Connect the repository to a new Railway project.
3. Configure the environment variables in the Railway dashboard.
4. Railway will automatically detect the `package.json` in the `server` directory and deploy the application.

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

---
*Created by [xcv](https://github.com/yourusername)*
