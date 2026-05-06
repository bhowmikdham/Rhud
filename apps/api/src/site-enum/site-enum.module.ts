import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ThreadModule } from '../thread/thread.module.js';
import { SiteEnumService } from './site-enum.service.js';
import {
  SiteEnumController,
  SiteEnumRetryController,
} from './site-enum.controller.js';
import { CrawlerService } from './crawler.service.js';
import { JsCrawlerService } from './js-crawler.service.js';
import { SiteClassifierService } from './classifier.service.js';
import { SiteScopeMapperService } from './mapper.service.js';

/**
 * Site enumeration — given a URL, crawl + classify a prospect's site
 * and feed the categorised counts into the existing pricing engine
 * via PricingService.quote(). See site-enum.service.ts for the
 * lifecycle.
 *
 * forwardRef on LlmModule mirrors ExtractionModule's pattern — the
 * graph doesn't currently cycle, but LlmModule transitively depends
 * on IntegrationsModule and the forward-ref hardens against future
 * cycles cheaply.
 */
@Module({
  imports: [
    AuthModule,
    PricingModule,
    ThreadModule,
    forwardRef(() => LlmModule),
  ],
  controllers: [SiteEnumController, SiteEnumRetryController],
  providers: [
    SiteEnumService,
    CrawlerService,
    JsCrawlerService,
    SiteClassifierService,
    SiteScopeMapperService,
  ],
  exports: [SiteEnumService],
})
export class SiteEnumModule {}
