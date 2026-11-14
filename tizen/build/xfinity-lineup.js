// Xfinity lineups that Settings > Xfinity can suggest from ("Gary's suggestions"): each channel
// is [Xfinity number, name, ...names a channel list might use]. A name that is a call sign
// (WBBM) only matches a channel that also names the lineup's city, so another city's CBS isn't
// taken for this one. Numbers from tvtv.us (Xfinity Chicago Areas 1, 4 & 5); which channels are
// in Popular TV from xfinity.com's lineup (its "TV Plus" column, 125+ channels). November 2026.
const XFINITY_LINEUPS = {
  'chicago-popular': {
    name: 'Xfinity Chicago (Areas 1, 4 & 5), Popular TV',
    city: 'CHICAGO',
    channels: [
      [2, 'WBBM CBS 2', 'WBBM'], [4, 'WSNS Telemundo', 'WSNS'], [5, 'WMAQ NBC 5', 'WMAQ'], [6, 'WGBO Univision', 'WGBO'],
      [7, 'WLS ABC 7', 'WLS'], [8, 'WPWR My50', 'WPWR'], [9, 'WGN 9', 'WGN', 'WGN9', 'WGN 9'], [11, 'WTTW PBS', 'WTTW'],
      [12, 'WFLD FOX 32', 'WFLD'], [13, 'WCIU The U', 'WCIU', 'THE U'], [15, 'WXFT UniMás', 'WXFT'], [17, 'WYIN PBS', 'WYIN'],
      [38, 'WCPX ION', 'WCPX'], [380, 'TBN (WWTO)', 'WWTO', 'TBN', 'TRINITY BROADCASTING NETWORK'],
      [3, 'ESPN', 'ESPN'], [16, 'HSN', 'HSN'], [24, 'FX', 'FX'], [30, 'ESPN2', 'ESPN2', 'ESPN 2'], [32, 'TNT', 'TNT'], [33, 'TBS', 'TBS'],
      [39, 'USA Network', 'USA', 'USA NETWORK'], [40, 'Freeform', 'FREEFORM'], [41, 'Lifetime', 'LIFETIME'], [43, 'AMC', 'AMC'],
      [44, 'Bravo', 'BRAVO'], [45, 'Animal Planet', 'ANIMAL PLANET'], [46, 'Discovery', 'DISCOVERY', 'DISCOVERY CHANNEL'],
      [52, 'Big Ten Network', 'BIG TEN NETWORK', 'BTN', 'B1G NETWORK', 'BIG 10 NETWORK'], [54, 'Nickelodeon', 'NICKELODEON', 'NICK'],
      [55, 'Disney Channel', 'DISNEY CHANNEL', 'DISNEY'], [57, 'CNN', 'CNN'], [58, 'CNBC', 'CNBC'], [59, 'MS NOW', 'MS NOW', 'MSNOW', 'MSNBC'],
      [60, 'Fox News', 'FOX NEWS', 'FOX NEWS CHANNEL', 'FNC'], [61, 'HLN', 'HLN'], [62, 'Bloomberg', 'BLOOMBERG', 'BLOOMBERG TV', 'BLOOMBERG TELEVISION'],
      [63, 'HGTV', 'HGTV'], [64, 'A&E', 'A&E', 'A AND E', 'AE'], [65, 'History', 'HISTORY', 'HISTORY CHANNEL'], [66, 'Oxygen', 'OXYGEN', 'OXYGEN TRUE CRIME'],
      [69, 'TLC', 'TLC'], [70, 'Food Network', 'FOOD NETWORK', 'FOOD'], [71, 'E!', 'E!', 'E', 'E ENTERTAINMENT', 'E! ENTERTAINMENT', 'E! ENTERTAINMENT TELEVISION'],
      [72, 'Comedy Central', 'COMEDY CENTRAL'], [73, 'Golf Channel', 'GOLF CHANNEL', 'GOLF'], [74, 'VH1', 'VH1'], [75, 'BET', 'BET'], [76, 'MTV', 'MTV'],
      [83, 'Travel Channel', 'TRAVEL CHANNEL', 'TRAVEL'], [95, 'QVC', 'QVC'], [98, 'C-SPAN', 'C-SPAN', 'C-SPAN 1', 'CSPAN', 'CSPAN 1', 'C SPAN'],
      [99, 'The Weather Channel', 'THE WEATHER CHANNEL', 'WEATHER CHANNEL', 'TWC'], [104, 'C-SPAN2', 'C-SPAN2', 'C-SPAN 2', 'CSPAN2', 'CSPAN 2'],
      [105, 'C-SPAN3', 'C-SPAN3', 'C-SPAN 3', 'CSPAN3', 'CSPAN 3'], [106, 'Fox Business', 'FOX BUSINESS', 'FOX BUSINESS NETWORK', 'FBN'],
      [119, 'EWTN', 'EWTN'], [131, 'Hallmark Channel', 'HALLMARK CHANNEL', 'HALLMARK'], [150, 'Ovation', 'OVATION'], [160, 'SYFY', 'SYFY'],
      [161, 'Game Show Network', 'GAME SHOW NETWORK', 'GSN'], [162, 'BBC America', 'BBC AMERICA'], [163, 'TV Land', 'TV LAND', 'TVLAND'],
      [165, 'truTV', 'TRUTV', 'TRU TV'], [172, 'TV One', 'TV ONE', 'TVONE'], [205, 'MotorTrend', 'MOTORTREND', 'MOTOR TREND', 'DISCOVERY TURBO'],
      [206, 'National Geographic', 'NATIONAL GEOGRAPHIC', 'NAT GEO', 'NATGEO', 'NATIONAL GEOGRAPHIC CHANNEL'], [209, 'MTV Live', 'MTV LIVE'],
      [217, 'Localish', 'LOCALISH'], [220, 'OWN', 'OWN', 'OPRAH WINFREY NETWORK'], [223, 'NewsNation', 'NEWSNATION', 'NEWS NATION'],
      [227, 'Hallmark Mystery', 'HALLMARK MYSTERY', 'HALLMARK MOVIES & MYSTERIES', 'HALLMARK MOVIES AND MYSTERIES'],
      [229, 'LMN', 'LMN', 'LIFETIME MOVIES', 'LIFETIME MOVIE NETWORK'], [236, 'Tennis Channel', 'TENNIS CHANNEL'], [237, 'FS1', 'FS1', 'FOX SPORTS 1'],
      [271, 'Investigation Discovery', 'INVESTIGATION DISCOVERY', 'ID'], [401, 'FXX', 'FXX'], [409, 'FS2', 'FS2', 'FOX SPORTS 2'],
      [475, 'UPtv', 'UPTV', 'UP TV'], [484, 'Great American Family', 'GREAT AMERICAN FAMILY', 'GAF'], [491, 'Cleo TV', 'CLEO TV'], [502, 'WE tv', 'WE TV', 'WETV'],
      [1108, 'FOX Weather', 'FOX WEATHER'], [1115, 'Newsmax', 'NEWSMAX', 'NEWSMAX TV'], [1211, 'NBC Sports Network', 'NBC SPORTS NETWORK', 'NBCSN'],
      [1431, 'INSP', 'INSP'], [1437, 'Comedy.TV', 'COMEDY.TV', 'COMEDY TV'], [1446, 'Justice Central', 'JUSTICE CENTRAL'], [1483, 'Recipe.TV', 'RECIPE TV', 'RECIPE.TV'],
      [1623, 'AFRO', 'AFRO'], [1627, 'ASPiRE', 'ASPIRE'], [1636, 'TheGrio', 'THEGRIO', 'THE GRIO'], [1637, 'REVOLT', 'REVOLT'], [1684, 'JBS', 'JBS'],
      [1721, 'Primo TV', 'PRIMO TV'], [1722, 'Kids Street', 'KIDS STREET'], [1736, 'MeTV Toons', 'METV TOONS'],
      [338, 'Start TV', 'START TV', 'STARTTV'], [339, 'Dabl', 'DABL'], [341, 'Cozi TV', 'COZI', 'COZI TV'], [342, 'LX News', 'LX', 'LX NEWS'],
      [352, 'Rewind TV', 'REWIND TV'], [353, 'Antenna TV', 'ANTENNA TV'], [354, 'Grit', 'GRIT', 'GRIT TV'], [355, 'Bounce', 'BOUNCE', 'BOUNCE TV'],
      [357, 'MeTV', 'METV', 'ME TV'], [358, 'H&I', 'H&I', 'HEROES & ICONS', 'HEROES AND ICONS'], [359, 'Catchy Comedy', 'CATCHY COMEDY'],
      [361, 'Story Television', 'STORY TELEVISION', 'STORY TV'], [363, 'Movies!', 'MOVIES!', 'MOVIES TV NETWORK'], [364, 'Buzzr', 'BUZZR'], [365, 'ROAR', 'ROAR'],
      [368, 'PBS Kids', 'PBS KIDS'], [377, 'NHK World', 'NHK', 'NHK WORLD', 'NHK WORLD JAPAN'], [394, 'TeleXitos', 'TELEXITOS'], [396, 'Estrella TV', 'ESTRELLA TV', 'ESTRELLA'],
    ],
  },
};
