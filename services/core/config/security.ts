
export function getEncryptSensitiveFields(): boolean {
  const raw = process.env.ENCRYPT_SENSITIVE_FIELDS
  return raw === 'true' || raw === '1'
}
