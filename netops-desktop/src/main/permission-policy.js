"use strict";

// Browser permissions are denied unless the operator explicitly enables the
// exact permission name in defaultPermissions. Invalid configuration fails
// closed instead of accidentally granting a permission.
function isPermissionAllowed(configured, requested) {
  if (typeof requested !== "string" || !requested) return false;
  if (!Array.isArray(configured)) return false;
  return configured.some((permission) => permission === requested);
}

module.exports = { isPermissionAllowed };
