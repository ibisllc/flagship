export type Bytes = Uint8Array;

export type UserId = string;
export type ServerId = string;

export interface Keypair {
  publicKey: Bytes;
  privateKey: Bytes;
}

export interface UserMasterKey {
  seed: Bytes;
}
