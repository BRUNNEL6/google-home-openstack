import { GoogleHomePlugin, IGoogleHomePlugin } from '../../core/google-home-plugin';
import { OpenstackService } from './openstack.service';
import { OpenstackConfig, Sizes, Distribution, Version } from '../../common/app-settings.interface';
import { ConfigService } from '../../core/config.service';
import { DistributionNotFoundError, VersionNotFoundError, SizeDoesNotExistError, UndefinedParameterError, MaxFloatingIpAttemptsExceededError } from './errors';
import { OpenstackError } from './errors/openstack.error';
import { IncomingMessage } from '../../common/incoming-message.interface';
import * as i18next from 'i18next';
import { Logger } from '../../util/logger';
import { DialogflowResponse } from '../../common/dialogflow-response';
import { OpenstackHumanService } from './openstack-human.service';
import { FloatingIPCreateDto } from './interfaces';
import { CompanyDNSService } from './company-dns/company-dns.service';
import * as safename from 'safename';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const replaceAll = (msg, search, replacement) => msg.split(search).join(replacement);

export type VMSize = 'small' | 'medium' | 'large';

export interface CreateVMParameters {
    size: VMSize;
    distributions: string;
    version: string;
    count: number;
    'vm-name': string;
    'vm-port': string;
    'create-vm': string;
    'resolve-dns': string;
}

export type CreateVMMessage = IncomingMessage<CreateVMParameters>;


@GoogleHomePlugin({
    requiredParameters: [
        'create-vm'
    ]
})
export class CreateVMPlugin implements IGoogleHomePlugin {
    private openstack: OpenstackService;
    private config: OpenstackConfig;
    private t: i18next.TranslationFunction;
    private openstackHuman: OpenstackHumanService;
    private companyDNSSerivce: CompanyDNSService;

    constructor() {
        this.openstack = OpenstackService.Instance;
        this.openstackHuman = OpenstackHumanService.Instance;
        const config = ConfigService.getConfig();
        this.config = config.openstack;
        this.t = i18next.getFixedT(null, 'openstack');
        this.companyDNSSerivce = new CompanyDNSService(config);
    }

    private getFlavorBySize(size: VMSize): string {
        const newSize = this.config.sizes[size];
        if (!newSize) {
            throw new SizeDoesNotExistError(size);
        }
        return newSize;
    }

    private getDistribution(distribution: string) {
        const dist = this.config.distributions.find(d => d.name === distribution);
        if (!dist) {
            throw new DistributionNotFoundError(distribution);
        }
        return dist;
    }

    getVersion(distribution: Distribution, version: string): Version {
        const vers = distribution.versions.find(v => v.name === version);
        if (!vers) {
            throw new VersionNotFoundError(distribution.name, version);
        }
        return vers;
    }

    mapOpenstackParams(params: CreateVMParameters) {
        let flavorRef, distribution, version, imageRef;
        if (!params.distributions) {
            throw new UndefinedParameterError(this.t('questions.distribution'))
        }

        distribution = this.getDistribution(replaceAll(params.distributions, ' ', ''));

        if (!params.version) {
            throw new UndefinedParameterError(this.t('questions.version'));
        }

        imageRef = this.getVersion(distribution, replaceAll(params.version, ' ', '')).ref;

        if (!params.size) {
            const sizes = this.openstackHuman.listAllSizes();
            throw new UndefinedParameterError(this.t('questions.size', { sizes }));
        }

        flavorRef = this.getFlavorBySize(params.size);

        if (!params["vm-name"]) {
            throw new UndefinedParameterError('name');
        }

        return {
            name: params["vm-name"],
            flavorRef,
            imageRef: imageRef,
            networks: [{
                uuid: this.config.defaultNetworkUUID
            }],
            key_name: this.config.defaultKeyPairName
        };
    }

    private async assoicateFloatingIp(serverId: string, ip: string, reconnectingAttempts: number = 0) {
        Logger.debug('Retrying to associate floating ip');
        await sleep(this.config.associatingIpSleep || 1000);
        try {
            return await this.openstack.associateFloatingIp(serverId, ip);
        } catch (err) {
            reconnectingAttempts++;
            if ((this.config.maxAssociatingIpRetries || 3) <= reconnectingAttempts) {
                throw new MaxFloatingIpAttemptsExceededError();
            }
            return await this.assoicateFloatingIp(serverId, ip, reconnectingAttempts);
        }
    }

    async onMessage(message: CreateVMMessage): Promise<DialogflowResponse> {
        const params = message.data.parameters;
        let server;
        let serverCount = params.count || 1;
        let serverCreated = 0;
        try {
            server = this.mapOpenstackParams(params);
            for (serverCreated = 0; serverCreated < serverCount; serverCreated++) {
                const newServer = await this.openstack.createServer(server);
                const floatingIp: FloatingIPCreateDto = await this.openstack.createFloatingIP(this.config.defaultFloatingIpPool);
                // TODO: Check state of vm instead of timeout
                await this.assoicateFloatingIp(newServer.id, floatingIp.ip);
                const allConfig = ConfigService.getConfig();
                if (allConfig.companyDNSAPIAddress && params["resolve-dns"] === 'true') {
                    const dnsName = safename.middle(server.name.trim().toLowerCase());
                    try {
                        await this.companyDNSSerivce.setupDNS(dnsName, floatingIp.ip);
                    } catch (err) {
                        console.log(err);
                    }
                    console.log(allConfig.companyDNSDomain.replace('{}', dnsName));
                    return this.t('created-vm-dns', { domain: allConfig.companyDNSDomain.replace('{}', dnsName), 'interpolation': { 'escapeValue': false } });
                } else {
                    return this.t('created-vm', { name: params["vm-name"] });
                }
            }
        }
        catch (err) {
            if (err instanceof OpenstackError) {
                return {
                    fulfillmentText: err.message,
                };
            } else {
                Logger.error(err);
                return this.t('internal-error', { ns: 'common' });
            }
        }

    }

    async onInit() {
        await this.openstack.updateToken();
    }
}
