import { randomBytes, createHash } from "node:crypto";
import { CoseSignatureAlgorithmEnum, encodeCoseKey, SignOptions, sign } from "@mattrglobal/cose";
import * as jose from "jose";
import cbor from "cbor";
import cose from "cose-js";
import { IssuerSignedItem } from "./types/MDOC";
import { cborTagged, convertJWKtoJsonWebKey, fromPEM, maybeEncodeValue } from "./utils";

export class MDOCBuilder {
  public readonly defaultDocType = "org.iso.18013.5.1.mDL";
  public readonly defaultNamespace = "org.iso.18013.5.1";
  public readonly digestAlgo = "sha256";

  public namespaces = new Set<string>();
  private mapOfDigests: Record<string, any> = {};
  private mapOfHashes: Record<string, any> = {};

  issuerCertificatePem: string;
  issuerPrivateKeyPem: string;

  constructor(issuerCertificatePem: string, issuerPrivateKeyPem: string) {
    this.issuerCertificatePem = issuerCertificatePem;
    this.issuerPrivateKeyPem = issuerPrivateKeyPem;
  }

  async addNameSpace(namespace: string, values: Record<string, any>) {
    if (namespace === this.defaultNamespace) {
      this.validateValues(values);
    }
    this.namespaces.add(namespace);
    this.mapOfDigests[namespace] = {};
    this.mapOfHashes[namespace] = {};
    let digestCounter = 0;

    for (const [key, value] of Object.entries(values)) {
      const { digest, hash } = await this.processAttribute(key, value, digestCounter);
      this.mapOfDigests[namespace][digestCounter] = digest;
      this.mapOfHashes[namespace][digestCounter] = hash;
      digestCounter++;
    }
  }

  async save(): Promise<Buffer> {
    const issuerAuth = await this.buildMSO();
    const nameSpaces = {};
    for (const ns of this.namespaces.values()) {
      nameSpaces[ns] = [];
      for (const [key, val] of Object.entries(this.mapOfDigests[ns])) {
        const data = await cborTagged(24, await cbor.encode(val));
        nameSpaces[ns].push(data);
      }
    }
    const mdl = {
      version: "1.0",
      documents: [
        {
          docType: this.defaultDocType,
          issuerSigned: {
            nameSpaces,
            issuerAuth,
          },
        },
      ],
      status: 0,
    };

    const mdlCbor = await cbor.encode(mdl);

    return mdlCbor;
  }

  /**  ---- Internal ----  */

  private async processAttribute(
    key: string,
    value: any,
    digestID: number
  ): Promise<{ digest: IssuerSignedItem; hash: Buffer }> {
    const salt = randomBytes(32);
    const encodedValue = maybeEncodeValue(key, value);

    const digest: IssuerSignedItem = {
      digestID,
      random: salt,
      elementIdentifier: key,
      elementValue: encodedValue,
    };

    const hash = await this.hashDigest(digest);
    return { digest, hash };
  }

  async hashDigest(digest: IssuerSignedItem): Promise<Buffer> {
    const enc = await cbor.encode(digest);
    const dataToHash = await cbor.encode(new cbor.Tagged(24, enc));
    const sha256Hash = createHash(this.digestAlgo).update(dataToHash).digest();

    return sha256Hash;
  }

  validateValues(values) {
    // TODO
    // validate required fields, no extra fields, data types, etc...
  }

  formatDate(date: Date): string {
    return date.toISOString().split(".")[0] + "Z";
  }

  async buildMSO() {
    const issuerPrivateKey =  await jose.importPKCS8(this.issuerPrivateKeyPem, "");
    const jwk = await jose.exportJWK(issuerPrivateKey);
    const issuerPublicKeyBuffer = fromPEM(this.issuerCertificatePem)


    const utcNow = new Date();
    const expTime = new Date();
    expTime.setHours(expTime.getHours() + 5);

    const signedDate = await cbor.encode(new cbor.Tagged(0, this.formatDate(utcNow)));
    const validFromDate = await cbor.encode(new cbor.Tagged(0, this.formatDate(utcNow)));
    const validUntilDate = await cbor.encode(new cbor.Tagged(0, this.formatDate(expTime)));

    const mso = {
      version: "1.0",
      digestAlgorithm: this.digestAlgo,
      valueDigests: this.mapOfHashes,
      deviceKeyInfo: {
        deviceKey: "deviceKey", // TODO: what is this?
      },
      docType: this.defaultDocType,
      validityInfo: {
        signed: signedDate,
        validFrom: validFromDate,
        validUntil: validUntilDate,
      },
    };

    const msoCbor = cbor.encode(mso);

    const pkThing = convertJWKtoJsonWebKey(jwk);
    const signOptions: SignOptions = {
      algorithm: CoseSignatureAlgorithmEnum.ES256,
      payload: msoCbor,
      signers: [
        {
          algorithm: CoseSignatureAlgorithmEnum.ES256,
          privateKey: pkThing,
        },
      ],
      // privateKey: convertJWKtoJsonWebKey(jwk),
      protectedHeaders: {
        alg: "ES256",
      },
      unprotectedHeaders: {
        x5chain: [issuerPublicKeyBuffer],
        kid: "11", // What is this ???
      },
      skipEncodingPayload: true,
    };
    const signedCbor = await sign(signOptions);

    // signedCbor is a cbor of an object with shape {err, tag, value}. We only want the value
    // so we need to decode it and extract it
    const decoded = await cbor.decode(signedCbor);
    return decoded.value;
  }
}
