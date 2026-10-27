const mongoose = require("mongoose")
const { PERMISSIONS, ROLE_PERMISSIONS, ROLES } = require("../utils/permissions")

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        minlength: 3,
        maxlength: 64
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: [...ROLES, "PURCHASE"], required: true },
    permissions: {
        type: [{ type: String, enum: PERMISSIONS }],
        default: undefined
    },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null }
}, { timestamps: true })

userSchema.pre("validate", function setDefaultPermissions() {
    if (!this.permissions) {
        this.permissions = [...ROLE_PERMISSIONS[this.role]]
    }
})

module.exports = mongoose.model("User", userSchema)
