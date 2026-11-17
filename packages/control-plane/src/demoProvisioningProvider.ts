export interface ProvisioningHetznerClient {
  findServerByName?(
    name: string,
  ): Promise<{ serverId: string; ipv4: string | null } | null>;
  createServerWithUserData(args: {
    name: string;
    location: string;
    serverType: string;
    image?: string;
    userData: string;
    username: string;
    sshKeyId?: number;
    fallbackServerTypes?: readonly string[];
    /** Also give the server a public IPv6 address (UpCloud only; others ignore it). */
    ipv6?: boolean;
  }): Promise<{ serverId: string; ipv4: string | null; ipv6?: string | null }>;
}
