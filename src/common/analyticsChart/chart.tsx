import { useState } from "react";
import "./chart.css"
import Chart from "react-apexcharts"
import type { ApexOptions } from "apexcharts"
import useTimes from "../../hooks/loggedTimesHook";

interface chartData {
    loggedTimes: {
        seconds: number;
        formattedTime: string;
    }[];
    harnNumber: string;
    buildNumber: number;
    buildTimeEst: {
        seconds: number; 
        formattedTime: string;
    }
}

interface seriesSettings {
    name: string;
    data: { x: string, y: number }[]
}

interface chartPlots {
    loggedTimes: {
        x: string
        y: number;
    }[]
}

function AnalyticsChart({ loggedTimes, harnNumber, buildNumber, buildTimeEst }: chartData) {

    const chartData = loggedTimes.map((time, i) => ({
        x: `Build ${i + 1}`,
        y: Math.round(time.seconds / 60)
    }));
    
    const series = [
        {
            name: "Sessions",
            data: chartData
        }
    ];
    
    const apexOptions: ApexOptions = {
        chart: {
            type: "line",
            toolbar: { show: false },
            foreColor: "#FFFFFF"
        },
        title: {
            text: "Build Analytics",
            align: "center",
            style: {
                fontSize: '20px'
            }
        },
        xaxis: {
            type: "category",
            labels: {
                rotateAlways: true,
                rotate: -45,
                offsetY: 10
            }
        },
        yaxis: {
            min: 0,
            title: {
                text: "Minutes",
                style: {
                    fontSize: '20px'
                },
            }
        },
        annotations: {
            yaxis: [
                {
                    y: buildTimeEst.seconds / 60,
                    borderColor: '#F527F5',
                    strokeDashArray: 0,
                    borderWidth: 2,
                    label: {
                        borderColor: '#FF4560',
                        style: {
                            color: '#FFFFFF',
                            background: '#000000',
                        },
                        text: 'Estimated Time'
                    }
                }
            ]
        },
        stroke: {
            curve: "straight",
            width: 3,
        },
        colors: ["#27F546"],
        markers: {
            size: 8
        },
    };
    
    

    return (
        <div className="chart">
            <Chart
                options={apexOptions}
                series={series}
                type="line"
                height={350}
                width={900}
            />
        </div>
    )
}

export default AnalyticsChart