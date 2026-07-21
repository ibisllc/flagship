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
  }): Promise<{ serverId: string; ipv4: string | null }>;
}
