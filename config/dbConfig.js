const mongoose = require("mongoose")

const connectDB = async (uri) => {
    if (!uri) {
        throw new Error("MONGODB_URI is required")
    }

    await mongoose.connect(uri)
    console.log("Database connected")
}

module.exports = connectDB
