const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const generateSessionId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

export const generateToken = () =>
  crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

export const generateAccessCode = (existingAccessCodes: ReadonlyMap<string, string>) => {
  while (true) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (value) => {
      return ACCESS_CODE_ALPHABET[value % ACCESS_CODE_ALPHABET.length];
    }).join("");

    if (!existingAccessCodes.has(code)) {
      return code;
    }
  }
};
