import type { Response } from "express";
import type {
  AuthInfo,
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/server";

/** The validated parameters of an authorization request, handed to the provider. */
export interface AuthorizationParams {
  state?: string;
  scopes?: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: URL;
}

/** Where registered OAuth clients live, and the dynamic client registration policy. */
export interface OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined | Promise<OAuthClientInformationFull | undefined>;
  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull | Promise<OAuthClientInformationFull>;
}

/** Verifies access tokens presented to the resource server. Failures throw `OAuthHttpError`. */
export interface OAuthTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

/**
 * Everything the authorization-server endpoints need from DevSpace. The endpoints parse and
 * validate the protocol messages; the provider owns approval, codes, tokens, and policy.
 * Failures throw `OAuthHttpError`.
 */
export interface OAuthServerProvider extends OAuthTokenVerifier {
  readonly clientsStore: OAuthRegisteredClientsStore;

  /** Answers an authorization request: renders the approval page, or redirects with a code. */
  authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void>;

  /** The PKCE S256 code challenge recorded for an authorization code issued to this client. */
  challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string>;

  /**
   * Exchanges an authorization code whose PKCE verifier has already been checked by the token
   * endpoint. The verifier argument is always `undefined`: DevSpace validates PKCE locally.
   */
  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens>;

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens>;

  revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void>;
}
